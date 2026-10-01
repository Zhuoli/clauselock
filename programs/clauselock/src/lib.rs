//! ClauseLock: a single-contributor bounty escrow whose terms cannot change after acceptance.
//!
//! The sponsor funds a program-owned PDA with native SOL. The program itself derives a
//! `terms_hash` from the executable fields (parties, amount, deadlines, refund policy, schema
//! version) plus the SHA-256 of the human-readable canonical terms document. The contributor
//! accepts by echoing that exact hash. No instruction can edit terms after creation.
//!
//! Time semantics (see README): `Clock::unix_timestamp` at *execution* time governs.
//! Positive actions must happen strictly before their deadline (`now < deadline`);
//! expiry-based refunds become available at the deadline (`now >= deadline`).
//!
//! States: Funded -> Accepted -> Submitted -> Approved -> Paid
//!         Funded --(sponsor cancel, or now >= accept_by)--> Refunded
//!         Accepted --(now >= submit_by)--> Refunded
//!         Submitted --(now >= review_by)--> Refunded
//!         Approved never refunds.
use anchor_lang::prelude::*;

declare_id!("B5qem1S6padkAWwpAYzHeNDjnPHN6NHdmWRuacgvdgDu");

pub mod constants {
    use super::*;

    #[constant]
    pub const ESCROW_SEED: &[u8] = b"escrow";
    /// Domain separator for the terms commitment preimage.
    pub const TERMS_DOMAIN: &[u8] = b"CLAUSELOCK_TERMS_V1";
    #[constant]
    pub const SCHEMA_VERSION: u8 = 1;
    /// Minimum reward. Keeps a fresh (0-lamport) contributor wallet rent-exempt after payout.
    #[constant]
    pub const MIN_AMOUNT: u64 = 1_000_000;
    /// Refund policy 0: if the escrow is not Approved by the governing deadline, anyone may
    /// return the reward to the sponsor. The only policy in schema v1.
    #[constant]
    pub const REFUND_TO_SPONSOR_ON_EXPIRY: u8 = 0;
}

pub mod state {
    use super::*;

    #[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
    pub enum EscrowState {
        Funded,
        Accepted,
        Submitted,
        Approved,
        Paid,
        Refunded,
    }

    #[account]
    #[derive(InitSpace)]
    pub struct Escrow {
        pub schema_version: u8,
        pub bump: u8,
        pub escrow_id: u64,
        pub sponsor: Pubkey,
        pub contributor: Pubkey,
        /// Reward in lamports, held on top of this account's rent-exempt reserve.
        pub amount: u64,
        pub accept_by: i64,
        pub submit_by: i64,
        pub review_by: i64,
        pub refund_policy: u8,
        /// SHA-256 of the canonical terms JSON (the document Fine Print produced).
        pub doc_digest: [u8; 32],
        /// SHA-256 over the executable fields + doc_digest, computed on-chain.
        pub terms_hash: [u8; 32],
        pub evidence_hash: [u8; 32],
        pub state: EscrowState,
        pub created_at: i64,
        pub accepted_at: i64,
        pub submitted_at: i64,
        pub approved_at: i64,
        pub settled_at: i64,
        /// Who sent the settling transaction (paid the fee).
        pub settled_by: Pubkey,
    }
}

pub mod error {
    use super::*;

    #[error_code]
    pub enum ClauseLockError {
        #[msg("Deadlines must satisfy now < accept_by < submit_by < review_by")]
        BadDeadlines,
        #[msg("Reward is below the minimum (0.001 SOL)")]
        AmountTooSmall,
        #[msg("Contributor must differ from sponsor and be non-default")]
        BadContributor,
        #[msg("Unknown refund policy for this schema version")]
        BadRefundPolicy,
        #[msg("Action not allowed in the escrow's current state")]
        WrongState,
        #[msg("The terms hash you signed does not match the on-chain commitment")]
        TermsMismatch,
        #[msg("The deadline for this action has passed")]
        DeadlinePassed,
        #[msg("Refund is not available yet: the governing deadline has not been reached")]
        RefundNotYetAvailable,
        #[msg("An approved escrow can never be refunded")]
        ApprovedCannotRefund,
        #[msg("Evidence hash must be non-zero")]
        EmptyEvidence,
        #[msg("Escrow does not hold enough lamports above its rent reserve")]
        InsufficientEscrowBalance,
    }
}

pub mod events {
    use super::*;

    #[event]
    pub struct EscrowFunded {
        pub escrow: Pubkey,
        pub sponsor: Pubkey,
        pub contributor: Pubkey,
        pub amount: u64,
        pub terms_hash: [u8; 32],
    }
    #[event]
    pub struct EscrowStateChanged {
        pub escrow: Pubkey,
        pub state: crate::state::EscrowState,
        pub at: i64,
        pub by: Pubkey,
    }
}

use constants::*;
use error::ClauseLockError;
use events::*;
use state::{Escrow, EscrowState};

/// Canonical preimage of the terms commitment (157 bytes, all integers little-endian).
/// Exposed so off-chain clients and tests can reproduce it; see `vectors/terms-hash-v1.json`.
#[allow(clippy::too_many_arguments)]
pub fn terms_preimage(
    schema_version: u8,
    sponsor: &Pubkey,
    contributor: &Pubkey,
    escrow_id: u64,
    amount: u64,
    accept_by: i64,
    submit_by: i64,
    review_by: i64,
    refund_policy: u8,
    doc_digest: &[u8; 32],
) -> Vec<u8> {
    let mut v = Vec::with_capacity(157);
    v.extend_from_slice(TERMS_DOMAIN);
    v.push(schema_version);
    v.extend_from_slice(sponsor.as_ref());
    v.extend_from_slice(contributor.as_ref());
    v.extend_from_slice(&escrow_id.to_le_bytes());
    v.extend_from_slice(&amount.to_le_bytes());
    v.extend_from_slice(&accept_by.to_le_bytes());
    v.extend_from_slice(&submit_by.to_le_bytes());
    v.extend_from_slice(&review_by.to_le_bytes());
    v.push(refund_policy);
    v.extend_from_slice(doc_digest);
    v
}

pub fn terms_hash_of(preimage: &[u8]) -> [u8; 32] {
    solana_sha256_hasher::hash(preimage).to_bytes()
}

/// Move the reward out of the program-owned escrow without touching its rent reserve.
fn pay_out(escrow_ai: &AccountInfo, dest: &AccountInfo, amount: u64) -> Result<()> {
    let rent_min = Rent::get()?.minimum_balance(escrow_ai.data_len());
    let available = escrow_ai.lamports().saturating_sub(rent_min);
    require!(available >= amount, ClauseLockError::InsufficientEscrowBalance);
    **escrow_ai.try_borrow_mut_lamports()? -= amount;
    **dest.try_borrow_mut_lamports()? += amount;
    Ok(())
}

#[program]
pub mod clauselock {
    use super::*;

    /// Sponsor creates and funds an escrow in one step. Terms are immutable from here on.
    #[allow(clippy::too_many_arguments)]
    pub fn create_fund(
        ctx: Context<CreateFund>,
        escrow_id: u64,
        contributor: Pubkey,
        amount: u64,
        accept_by: i64,
        submit_by: i64,
        review_by: i64,
        refund_policy: u8,
        doc_digest: [u8; 32],
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let sponsor = ctx.accounts.sponsor.key();
        require!(
            now < accept_by && accept_by < submit_by && submit_by < review_by,
            ClauseLockError::BadDeadlines
        );
        require!(amount >= MIN_AMOUNT, ClauseLockError::AmountTooSmall);
        require!(
            contributor != sponsor && contributor != Pubkey::default(),
            ClauseLockError::BadContributor
        );
        require!(
            refund_policy == REFUND_TO_SPONSOR_ON_EXPIRY,
            ClauseLockError::BadRefundPolicy
        );

        let pre = terms_preimage(
            SCHEMA_VERSION,
            &sponsor,
            &contributor,
            escrow_id,
            amount,
            accept_by,
            submit_by,
            review_by,
            refund_policy,
            &doc_digest,
        );
        let terms_hash = terms_hash_of(&pre);

        let e = &mut ctx.accounts.escrow;
        e.schema_version = SCHEMA_VERSION;
        e.bump = ctx.bumps.escrow;
        e.escrow_id = escrow_id;
        e.sponsor = sponsor;
        e.contributor = contributor;
        e.amount = amount;
        e.accept_by = accept_by;
        e.submit_by = submit_by;
        e.review_by = review_by;
        e.refund_policy = refund_policy;
        e.doc_digest = doc_digest;
        e.terms_hash = terms_hash;
        e.evidence_hash = [0u8; 32];
        e.state = EscrowState::Funded;
        e.created_at = now;
        e.settled_by = Pubkey::default();

        // Reward on top of the rent reserve Anchor's `init` already paid.
        anchor_lang::system_program::transfer(
            CpiContext::new(
                anchor_lang::system_program::ID,
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.sponsor.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                },
            ),
            amount,
        )?;

        emit!(EscrowFunded {
            escrow: ctx.accounts.escrow.key(),
            sponsor,
            contributor,
            amount,
            terms_hash,
        });
        Ok(())
    }

    /// Invited contributor accepts the exact terms commitment, strictly before `accept_by`.
    pub fn accept(ctx: Context<ContributorAction>, expected_terms_hash: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let e = &mut ctx.accounts.escrow;
        require!(e.state == EscrowState::Funded, ClauseLockError::WrongState);
        require!(now < e.accept_by, ClauseLockError::DeadlinePassed);
        require!(
            expected_terms_hash == e.terms_hash,
            ClauseLockError::TermsMismatch
        );
        e.state = EscrowState::Accepted;
        e.accepted_at = now;
        emit!(EscrowStateChanged { escrow: e.key(), state: e.state, at: now, by: ctx.accounts.contributor.key() });
        Ok(())
    }

    /// Contributor commits a hash of their deliverable, strictly before `submit_by`.
    pub fn submit_evidence(ctx: Context<ContributorAction>, evidence_hash: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let e = &mut ctx.accounts.escrow;
        require!(e.state == EscrowState::Accepted, ClauseLockError::WrongState);
        require!(now < e.submit_by, ClauseLockError::DeadlinePassed);
        require!(evidence_hash != [0u8; 32], ClauseLockError::EmptyEvidence);
        e.evidence_hash = evidence_hash;
        e.state = EscrowState::Submitted;
        e.submitted_at = now;
        emit!(EscrowStateChanged { escrow: e.key(), state: e.state, at: now, by: ctx.accounts.contributor.key() });
        Ok(())
    }

    /// Sponsor approves the submission, strictly before `review_by`. Irrevocable.
    pub fn approve(ctx: Context<SponsorAction>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let e = &mut ctx.accounts.escrow;
        require!(e.state == EscrowState::Submitted, ClauseLockError::WrongState);
        require!(now < e.review_by, ClauseLockError::DeadlinePassed);
        e.state = EscrowState::Approved;
        e.approved_at = now;
        emit!(EscrowStateChanged { escrow: e.key(), state: e.state, at: now, by: ctx.accounts.sponsor.key() });
        Ok(())
    }

    /// Sponsor withdraws an offer nobody has accepted yet.
    pub fn cancel(ctx: Context<SponsorSettle>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            ctx.accounts.escrow.state == EscrowState::Funded,
            ClauseLockError::WrongState
        );
        let amount = ctx.accounts.escrow.amount;
        pay_out(
            &ctx.accounts.escrow.to_account_info(),
            &ctx.accounts.sponsor.to_account_info(),
            amount,
        )?;
        let e = &mut ctx.accounts.escrow;
        e.state = EscrowState::Refunded;
        e.settled_at = now;
        e.settled_by = ctx.accounts.sponsor.key();
        emit!(EscrowStateChanged { escrow: e.key(), state: e.state, at: now, by: e.settled_by });
        Ok(())
    }

    /// Anyone may push an Approved escrow's reward to the fixed contributor address.
    pub fn finalize_payment(ctx: Context<FinalizePayment>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            ctx.accounts.escrow.state == EscrowState::Approved,
            ClauseLockError::WrongState
        );
        let amount = ctx.accounts.escrow.amount;
        pay_out(
            &ctx.accounts.escrow.to_account_info(),
            &ctx.accounts.contributor.to_account_info(),
            amount,
        )?;
        let e = &mut ctx.accounts.escrow;
        e.state = EscrowState::Paid;
        e.settled_at = now;
        e.settled_by = ctx.accounts.caller.key();
        emit!(EscrowStateChanged { escrow: e.key(), state: e.state, at: now, by: e.settled_by });
        Ok(())
    }

    /// Anyone may return the reward to the fixed sponsor address once the governing
    /// deadline for the current state has been reached. Approved escrows never refund.
    pub fn finalize_refund(ctx: Context<FinalizeRefund>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let e = &ctx.accounts.escrow;
        let governing = match e.state {
            EscrowState::Funded => e.accept_by,
            EscrowState::Accepted => e.submit_by,
            EscrowState::Submitted => e.review_by,
            EscrowState::Approved => return err!(ClauseLockError::ApprovedCannotRefund),
            EscrowState::Paid | EscrowState::Refunded => return err!(ClauseLockError::WrongState),
        };
        require!(now >= governing, ClauseLockError::RefundNotYetAvailable);
        let amount = e.amount;
        pay_out(
            &ctx.accounts.escrow.to_account_info(),
            &ctx.accounts.sponsor.to_account_info(),
            amount,
        )?;
        let e = &mut ctx.accounts.escrow;
        e.state = EscrowState::Refunded;
        e.settled_at = now;
        e.settled_by = ctx.accounts.caller.key();
        emit!(EscrowStateChanged { escrow: e.key(), state: e.state, at: now, by: e.settled_by });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct CreateFund<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,
    #[account(
        init,
        payer = sponsor,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [ESCROW_SEED, sponsor.key().as_ref(), &escrow_id.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, Escrow>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ContributorAction<'info> {
    pub contributor: Signer<'info>,
    #[account(
        mut,
        has_one = contributor,
        seeds = [ESCROW_SEED, escrow.sponsor.as_ref(), &escrow.escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
pub struct SponsorAction<'info> {
    pub sponsor: Signer<'info>,
    #[account(
        mut,
        has_one = sponsor,
        seeds = [ESCROW_SEED, sponsor.key().as_ref(), &escrow.escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
pub struct SponsorSettle<'info> {
    #[account(mut)]
    pub sponsor: Signer<'info>,
    #[account(
        mut,
        has_one = sponsor,
        seeds = [ESCROW_SEED, sponsor.key().as_ref(), &escrow.escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
}

#[derive(Accounts)]
pub struct FinalizePayment<'info> {
    /// Anyone: pays the transaction fee. Recorded as `settled_by`.
    pub caller: Signer<'info>,
    #[account(
        mut,
        has_one = contributor,
        seeds = [ESCROW_SEED, escrow.sponsor.as_ref(), &escrow.escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: must equal `escrow.contributor` (enforced by `has_one`); only credited.
    #[account(mut)]
    pub contributor: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct FinalizeRefund<'info> {
    /// Anyone: pays the transaction fee. Recorded as `settled_by`.
    pub caller: Signer<'info>,
    #[account(
        mut,
        has_one = sponsor,
        seeds = [ESCROW_SEED, escrow.sponsor.as_ref(), &escrow.escrow_id.to_le_bytes()],
        bump = escrow.bump
    )]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: must equal `escrow.sponsor` (enforced by `has_one`); only credited.
    #[account(mut)]
    pub sponsor: UncheckedAccount<'info>,
}
