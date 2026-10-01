//! LiteSVM tests for ClauseLock. The Clock sysvar is set explicitly so every deadline is
//! tested one second before, exactly at, and after.
use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    clauselock::{
        error::ClauseLockError,
        state::{Escrow, EscrowState},
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const T0: i64 = 1_760_000_000;
const ACCEPT_BY: i64 = T0 + 100;
const SUBMIT_BY: i64 = T0 + 200;
const REVIEW_BY: i64 = T0 + 300;
const AMOUNT: u64 = 1_000_000_000;
const SOL: u64 = 1_000_000_000;
const DOC: [u8; 32] = [9u8; 32];
const EVIDENCE: [u8; 32] = [7u8; 32];

fn code(e: ClauseLockError) -> u32 {
    anchor_lang::error::ERROR_CODE_OFFSET + e as u32
}
fn anchor_code(e: anchor_lang::error::ErrorCode) -> u32 {
    e as u32
}

struct Env {
    svm: LiteSVM,
    sponsor: Keypair,
    contributor: Keypair,
    stranger: Keypair,
    escrow: Pubkey,
    escrow_id: u64,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/clauselock.so"));
        svm.add_program(clauselock::id(), bytes).unwrap();
        let sponsor = Keypair::new();
        let contributor = Keypair::new();
        let stranger = Keypair::new();
        svm.airdrop(&sponsor.pubkey(), 10 * SOL).unwrap();
        // The contributor starts with only fee money; the stranger settles on others' behalf.
        svm.airdrop(&contributor.pubkey(), SOL / 100).unwrap();
        svm.airdrop(&stranger.pubkey(), SOL).unwrap();
        let escrow_id = 42u64;
        let escrow = escrow_pda(&sponsor.pubkey(), escrow_id);
        let mut env = Env { svm, sponsor, contributor, stranger, escrow, escrow_id };
        env.set_time(T0);
        env
    }

    fn set_time(&mut self, t: i64) {
        let mut c: Clock = self.svm.get_sysvar();
        c.unix_timestamp = t;
        c.slot += 1;
        self.svm.set_sysvar(&c);
    }

    fn send(&mut self, ix: Instruction, signers: &[&Keypair]) -> Result<(), String> {
        self.svm.expire_blockhash();
        let bh = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(&[ix], Some(&signers[0].pubkey()), &bh);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?} {:?}", e.err, e.meta.logs))
    }

    fn state(&self) -> Escrow {
        let acc = self.svm.get_account(&self.escrow).unwrap();
        Escrow::try_deserialize(&mut acc.data.as_slice()).unwrap()
    }
    fn lamports(&self, k: &Pubkey) -> u64 {
        self.svm.get_account(k).map(|a| a.lamports).unwrap_or(0)
    }

    fn create_ix(&self, id: u64, contributor: Pubkey, amount: u64, a: i64, s: i64, r: i64, policy: u8) -> Instruction {
        Instruction::new_with_bytes(
            clauselock::id(),
            &clauselock::instruction::CreateFund {
                escrow_id: id,
                contributor,
                amount,
                accept_by: a,
                submit_by: s,
                review_by: r,
                refund_policy: policy,
                doc_digest: DOC,
            }
            .data(),
            clauselock::accounts::CreateFund {
                sponsor: self.sponsor.pubkey(),
                escrow: escrow_pda(&self.sponsor.pubkey(), id),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }
    fn create(&mut self) -> Result<(), String> {
        let ix = self.create_ix(self.escrow_id, self.contributor.pubkey(), AMOUNT, ACCEPT_BY, SUBMIT_BY, REVIEW_BY, 0);
        let s = self.sponsor.insecure_clone();
        self.send(ix, &[&s])
    }
    fn contributor_ix(&self, signer: Pubkey, data: Vec<u8>) -> Instruction {
        Instruction::new_with_bytes(
            clauselock::id(),
            &data,
            clauselock::accounts::ContributorAction { contributor: signer, escrow: self.escrow }.to_account_metas(None),
        )
    }
    fn accept_as(&mut self, who: &Keypair, hash: [u8; 32]) -> Result<(), String> {
        let ix = self.contributor_ix(who.pubkey(), clauselock::instruction::Accept { expected_terms_hash: hash }.data());
        self.send(ix, &[who])
    }
    fn accept(&mut self) -> Result<(), String> {
        let h = self.state().terms_hash;
        let c = self.contributor.insecure_clone();
        self.accept_as(&c, h)
    }
    fn submit_as(&mut self, who: &Keypair, ev: [u8; 32]) -> Result<(), String> {
        let ix = self.contributor_ix(who.pubkey(), clauselock::instruction::SubmitEvidence { evidence_hash: ev }.data());
        self.send(ix, &[who])
    }
    fn submit(&mut self) -> Result<(), String> {
        let c = self.contributor.insecure_clone();
        self.submit_as(&c, EVIDENCE)
    }
    fn approve_as(&mut self, who: &Keypair) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            clauselock::id(),
            &clauselock::instruction::Approve {}.data(),
            clauselock::accounts::SponsorAction { sponsor: who.pubkey(), escrow: self.escrow }.to_account_metas(None),
        );
        self.send(ix, &[who])
    }
    fn approve(&mut self) -> Result<(), String> {
        let s = self.sponsor.insecure_clone();
        self.approve_as(&s)
    }
    fn cancel_as(&mut self, who: &Keypair) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            clauselock::id(),
            &clauselock::instruction::Cancel {}.data(),
            clauselock::accounts::SponsorSettle { sponsor: who.pubkey(), escrow: self.escrow }.to_account_metas(None),
        );
        self.send(ix, &[who])
    }
    fn pay_to(&mut self, caller: &Keypair, dest: Pubkey) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            clauselock::id(),
            &clauselock::instruction::FinalizePayment {}.data(),
            clauselock::accounts::FinalizePayment { caller: caller.pubkey(), escrow: self.escrow, contributor: dest }
                .to_account_metas(None),
        );
        self.send(ix, &[caller])
    }
    fn pay(&mut self) -> Result<(), String> {
        let (s, c) = (self.stranger.insecure_clone(), self.contributor.pubkey());
        self.pay_to(&s, c)
    }
    fn refund_to(&mut self, caller: &Keypair, dest: Pubkey) -> Result<(), String> {
        let ix = Instruction::new_with_bytes(
            clauselock::id(),
            &clauselock::instruction::FinalizeRefund {}.data(),
            clauselock::accounts::FinalizeRefund { caller: caller.pubkey(), escrow: self.escrow, sponsor: dest }
                .to_account_metas(None),
        );
        self.send(ix, &[caller])
    }
    fn refund(&mut self) -> Result<(), String> {
        let (s, d) = (self.stranger.insecure_clone(), self.sponsor.pubkey());
        self.refund_to(&s, d)
    }
}

fn escrow_pda(sponsor: &Pubkey, id: u64) -> Pubkey {
    Pubkey::find_program_address(&[clauselock::constants::ESCROW_SEED, sponsor.as_ref(), &id.to_le_bytes()], &clauselock::id()).0
}

#[track_caller]
fn expect_err(r: Result<(), String>, c: u32) {
    let e = r.expect_err("expected failure");
    assert!(e.contains(&format!("Custom({c})")), "expected Custom({c}), got {e}");
}

// ---------- happy path ----------

#[test]
fn full_vertical_slice_pays_contributor() {
    let mut env = Env::new();
    let sponsor_before = env.lamports(&env.sponsor.pubkey());
    env.create().unwrap();
    let e = env.state();
    assert_eq!(e.state, EscrowState::Funded);
    assert_eq!(e.amount, AMOUNT);
    assert_eq!(e.contributor, env.contributor.pubkey());
    let rent_min = env.svm.minimum_balance_for_rent_exemption(8 + <Escrow as anchor_lang::Space>::INIT_SPACE);
    assert_eq!(env.lamports(&env.escrow), rent_min + AMOUNT, "reward held on top of rent reserve");
    assert!(sponsor_before - env.lamports(&env.sponsor.pubkey()) >= AMOUNT + rent_min);

    env.set_time(T0 + 10);
    env.accept().unwrap();
    env.set_time(T0 + 150);
    env.submit().unwrap();
    assert_eq!(env.state().evidence_hash, EVIDENCE);
    env.set_time(T0 + 250);
    env.approve().unwrap();
    assert_eq!(env.state().state, EscrowState::Approved);

    let c_before = env.lamports(&env.contributor.pubkey());
    env.set_time(T0 + 10_000); // payment has no deadline once approved
    env.pay().unwrap();
    let e = env.state();
    assert_eq!(e.state, EscrowState::Paid);
    assert_eq!(e.settled_by, env.stranger.pubkey());
    assert_eq!(env.lamports(&env.contributor.pubkey()), c_before + AMOUNT, "stranger paid the fee, contributor got all");
    assert_eq!(env.lamports(&env.escrow), rent_min, "receipt account kept, rent reserve untouched");
    assert_eq!(e.accepted_at, T0 + 10);
    assert_eq!(e.submitted_at, T0 + 150);
    assert_eq!(e.approved_at, T0 + 250);
    assert_eq!(e.settled_at, T0 + 10_000);
}

#[test]
fn contributor_can_self_settle() {
    let mut env = Env::new();
    env.create().unwrap();
    env.accept().unwrap();
    env.submit().unwrap();
    env.approve().unwrap();
    let c = env.contributor.insecure_clone();
    let before = env.lamports(&c.pubkey());
    env.pay_to(&c, c.pubkey()).unwrap();
    assert_eq!(env.lamports(&c.pubkey()), before + AMOUNT - 5000);
}

// ---------- terms commitment ----------

#[test]
fn onchain_terms_hash_matches_preimage_and_vectors() {
    let mut env = Env::new();
    env.create().unwrap();
    let e = env.state();
    let pre = clauselock::terms_preimage(1, &e.sponsor, &e.contributor, e.escrow_id, AMOUNT, ACCEPT_BY, SUBMIT_BY, REVIEW_BY, 0, &DOC);
    assert_eq!(pre.len(), 157);
    assert_eq!(e.terms_hash, clauselock::terms_hash_of(&pre));
    assert_eq!(e.doc_digest, DOC);

    let v: serde_json::Value = serde_json::from_str(include_str!("../../../vectors/terms-hash-v1.json")).unwrap();
    for c in v["cases"].as_array().unwrap() {
        let pk = |k: &str| Pubkey::new_from_array(hex::decode(c[k].as_str().unwrap()).unwrap().try_into().unwrap());
        let doc: [u8; 32] = hex::decode(c["doc_digest_hex"].as_str().unwrap()).unwrap().try_into().unwrap();
        let pre = clauselock::terms_preimage(
            c["schema_version"].as_u64().unwrap() as u8,
            &pk("sponsor_hex"),
            &pk("contributor_hex"),
            c["escrow_id"].as_str().unwrap().parse::<u64>().unwrap(),
            c["amount"].as_str().unwrap().parse::<u64>().unwrap(),
            c["accept_by"].as_str().unwrap().parse::<i64>().unwrap(),
            c["submit_by"].as_str().unwrap().parse::<i64>().unwrap(),
            c["review_by"].as_str().unwrap().parse::<i64>().unwrap(),
            c["refund_policy"].as_u64().unwrap() as u8,
            &doc,
        );
        assert_eq!(hex::encode(&pre), c["preimage_hex"].as_str().unwrap(), "{}", c["name"]);
        assert_eq!(hex::encode(clauselock::terms_hash_of(&pre)), c["terms_hash_hex"].as_str().unwrap());
        assert_eq!(pk("sponsor_hex").to_string(), c["sponsor"].as_str().unwrap());
    }
}

#[test]
fn accept_with_mismatched_terms_hash_fails() {
    let mut env = Env::new();
    env.create().unwrap();
    let mut h = env.state().terms_hash;
    h[0] ^= 1;
    let c = env.contributor.insecure_clone();
    expect_err(env.accept_as(&c, h), code(ClauseLockError::TermsMismatch));
    // A hash computed with a different deadline (what a lying UI would show) also fails.
    let e = env.state();
    let pre = clauselock::terms_preimage(1, &e.sponsor, &e.contributor, e.escrow_id, AMOUNT, ACCEPT_BY, SUBMIT_BY + 86_400, REVIEW_BY, 0, &DOC);
    expect_err(env.accept_as(&c, clauselock::terms_hash_of(&pre)), code(ClauseLockError::TermsMismatch));
    assert_eq!(env.state().state, EscrowState::Funded);
}

// ---------- create_fund validation ----------

#[test]
fn create_validates_deadlines_amount_contributor_policy() {
    let mut env = Env::new();
    let s = env.sponsor.insecure_clone();
    let c = env.contributor.pubkey();
    let cases = [
        (env.create_ix(1, c, AMOUNT, T0, SUBMIT_BY, REVIEW_BY, 0), code(ClauseLockError::BadDeadlines)), // accept_by == now
        (env.create_ix(2, c, AMOUNT, ACCEPT_BY, ACCEPT_BY, REVIEW_BY, 0), code(ClauseLockError::BadDeadlines)),
        (env.create_ix(3, c, AMOUNT, ACCEPT_BY, SUBMIT_BY, SUBMIT_BY, 0), code(ClauseLockError::BadDeadlines)),
        (env.create_ix(4, c, AMOUNT, ACCEPT_BY, REVIEW_BY, SUBMIT_BY, 0), code(ClauseLockError::BadDeadlines)),
        (env.create_ix(5, c, 999_999, ACCEPT_BY, SUBMIT_BY, REVIEW_BY, 0), code(ClauseLockError::AmountTooSmall)),
        (env.create_ix(6, s.pubkey(), AMOUNT, ACCEPT_BY, SUBMIT_BY, REVIEW_BY, 0), code(ClauseLockError::BadContributor)),
        (env.create_ix(7, Pubkey::default(), AMOUNT, ACCEPT_BY, SUBMIT_BY, REVIEW_BY, 0), code(ClauseLockError::BadContributor)),
        (env.create_ix(8, c, AMOUNT, ACCEPT_BY, SUBMIT_BY, REVIEW_BY, 1), code(ClauseLockError::BadRefundPolicy)),
    ];
    for (ix, c) in cases {
        expect_err(env.send(ix, &[&s]), c);
    }
    // accept_by one second after now is fine
    env.send(env.create_ix(9, c, AMOUNT, T0 + 1, SUBMIT_BY, REVIEW_BY, 0), &[&s]).unwrap();
}

#[test]
fn create_twice_same_id_fails_and_underfunded_sponsor_leaves_no_escrow() {
    let mut env = Env::new();
    env.create().unwrap();
    assert!(env.create().is_err(), "PDA already in use");
    // Sponsor with too little SOL: whole tx fails atomically, no escrow account appears.
    let poor = Keypair::new();
    env.svm.airdrop(&poor.pubkey(), SOL / 10).unwrap();
    let pda = escrow_pda(&poor.pubkey(), 1);
    let ix = Instruction::new_with_bytes(
        clauselock::id(),
        &clauselock::instruction::CreateFund {
            escrow_id: 1, contributor: env.contributor.pubkey(), amount: AMOUNT,
            accept_by: ACCEPT_BY, submit_by: SUBMIT_BY, review_by: REVIEW_BY, refund_policy: 0, doc_digest: DOC,
        }.data(),
        clauselock::accounts::CreateFund { sponsor: poor.pubkey(), escrow: pda, system_program: system_program::ID }.to_account_metas(None),
    );
    assert!(env.send(ix, &[&poor]).is_err());
    assert!(env.svm.get_account(&pda).map(|a| a.lamports == 0).unwrap_or(true));
}

// ---------- wrong signer / PDA / destination ----------

#[test]
fn only_invited_contributor_can_accept_and_submit() {
    let mut env = Env::new();
    env.create().unwrap();
    let h = env.state().terms_hash;
    let st = env.stranger.insecure_clone();
    let has_one = anchor_code(anchor_lang::error::ErrorCode::ConstraintHasOne);
    expect_err(env.accept_as(&st, h), has_one);
    let sp = env.sponsor.insecure_clone();
    expect_err(env.accept_as(&sp, h), has_one);
    env.accept().unwrap();
    expect_err(env.submit_as(&st, EVIDENCE), has_one);
    let c = env.contributor.insecure_clone();
    expect_err(env.submit_as(&c, [0u8; 32]), code(ClauseLockError::EmptyEvidence));
}

#[test]
fn only_sponsor_can_approve_or_cancel() {
    let mut env = Env::new();
    env.create().unwrap();
    let st = env.stranger.insecure_clone();
    let c = env.contributor.insecure_clone();
    // Seeds are derived from the signer, so a non-sponsor signer fails seeds or has_one.
    assert!(env.cancel_as(&st).is_err());
    assert!(env.cancel_as(&c).is_err());
    env.accept().unwrap();
    env.submit().unwrap();
    assert!(env.approve_as(&st).is_err());
    assert!(env.approve_as(&c).is_err());
    assert_eq!(env.state().state, EscrowState::Submitted);
}

#[test]
fn payment_and_refund_destinations_are_fixed() {
    let mut env = Env::new();
    env.create().unwrap();
    env.accept().unwrap();
    env.submit().unwrap();
    env.approve().unwrap();
    let st = env.stranger.insecure_clone();
    let has_one = anchor_code(anchor_lang::error::ErrorCode::ConstraintHasOne);
    expect_err(env.pay_to(&st, st.pubkey()), has_one);
    expect_err(env.pay_to(&st, env.sponsor.pubkey()), has_one);

    let mut env = Env::new();
    env.create().unwrap();
    env.set_time(ACCEPT_BY);
    let st = env.stranger.insecure_clone();
    expect_err(env.refund_to(&st, st.pubkey()), has_one);
}

#[test]
fn forged_escrow_account_is_rejected() {
    // An account with the right layout but not owned by the program must be rejected.
    let mut env = Env::new();
    env.create().unwrap();
    let real = env.svm.get_account(&env.escrow).unwrap();
    let fake = Pubkey::new_unique();
    let mut forged = real.clone();
    forged.owner = system_program::ID;
    env.svm.set_account(fake, forged).unwrap();
    let st = env.stranger.insecure_clone();
    let ix = Instruction::new_with_bytes(
        clauselock::id(),
        &clauselock::instruction::FinalizeRefund {}.data(),
        clauselock::accounts::FinalizeRefund { caller: st.pubkey(), escrow: fake, sponsor: env.sponsor.pubkey() }.to_account_metas(None),
    );
    expect_err(env.send(ix, &[&st]), anchor_code(anchor_lang::error::ErrorCode::AccountOwnedByWrongProgram));
}

// ---------- replay / double settlement ----------

#[test]
fn no_double_payout_or_payout_after_refund() {
    let mut env = Env::new();
    env.create().unwrap();
    env.accept().unwrap();
    env.submit().unwrap();
    env.approve().unwrap();
    env.pay().unwrap();
    expect_err(env.pay(), code(ClauseLockError::WrongState));
    expect_err(env.refund(), code(ClauseLockError::WrongState));
    // Re-running earlier steps is rejected too.
    expect_err(env.accept(), code(ClauseLockError::WrongState));
    expect_err(env.submit(), code(ClauseLockError::WrongState));
    expect_err(env.approve(), code(ClauseLockError::WrongState));

    let mut env = Env::new();
    env.create().unwrap();
    env.set_time(ACCEPT_BY);
    env.refund().unwrap();
    expect_err(env.refund(), code(ClauseLockError::WrongState));
    expect_err(env.accept(), code(ClauseLockError::WrongState));
    let s = env.sponsor.insecure_clone();
    expect_err(env.cancel_as(&s), code(ClauseLockError::WrongState));
}

#[test]
fn identical_transaction_replay_is_rejected_by_runtime() {
    let mut env = Env::new();
    env.create().unwrap();
    let h = env.state().terms_hash;
    let ix = env.contributor_ix(env.contributor.pubkey(), clauselock::instruction::Accept { expected_terms_hash: h }.data());
    let bh = env.svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&env.contributor.pubkey()), &bh);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&env.contributor]).unwrap();
    env.svm.send_transaction(tx.clone()).unwrap();
    let e = env.svm.send_transaction(tx).unwrap_err();
    assert!(format!("{:?}", e.err).contains("AlreadyProcessed"), "{:?}", e.err);
}

// ---------- exact-second deadlines ----------

#[test]
fn accept_deadline_exact_second() {
    let mut env = Env::new();
    env.create().unwrap();
    env.set_time(ACCEPT_BY);
    expect_err(env.accept(), code(ClauseLockError::DeadlinePassed));
    env.set_time(ACCEPT_BY - 1);
    env.accept().unwrap();
}

#[test]
fn submit_deadline_exact_second() {
    let mut env = Env::new();
    env.create().unwrap();
    env.accept().unwrap();
    env.set_time(SUBMIT_BY);
    expect_err(env.submit(), code(ClauseLockError::DeadlinePassed));
    env.set_time(SUBMIT_BY + 1);
    expect_err(env.submit(), code(ClauseLockError::DeadlinePassed));
    env.set_time(SUBMIT_BY - 1);
    env.submit().unwrap();
}

#[test]
fn review_deadline_exact_second() {
    let mut env = Env::new();
    env.create().unwrap();
    env.accept().unwrap();
    env.submit().unwrap();
    env.set_time(REVIEW_BY);
    expect_err(env.approve(), code(ClauseLockError::DeadlinePassed));
    env.set_time(REVIEW_BY - 1);
    env.approve().unwrap();
}

#[test]
fn refund_unaccepted_exact_second() {
    let mut env = Env::new();
    env.create().unwrap();
    let before = env.lamports(&env.sponsor.pubkey());
    env.set_time(ACCEPT_BY - 1);
    expect_err(env.refund(), code(ClauseLockError::RefundNotYetAvailable));
    env.set_time(ACCEPT_BY);
    env.refund().unwrap();
    assert_eq!(env.state().state, EscrowState::Refunded);
    assert_eq!(env.lamports(&env.sponsor.pubkey()), before + AMOUNT);
}

#[test]
fn refund_unsubmitted_exact_second() {
    let mut env = Env::new();
    env.create().unwrap();
    env.accept().unwrap();
    env.set_time(SUBMIT_BY - 1);
    expect_err(env.refund(), code(ClauseLockError::RefundNotYetAvailable));
    env.set_time(SUBMIT_BY);
    env.refund().unwrap();
}

#[test]
fn refund_unapproved_exact_second() {
    let mut env = Env::new();
    env.create().unwrap();
    env.accept().unwrap();
    env.submit().unwrap();
    env.set_time(SUBMIT_BY + 50); // past submit_by, but the governing deadline is now review_by
    expect_err(env.refund(), code(ClauseLockError::RefundNotYetAvailable));
    env.set_time(REVIEW_BY - 1);
    expect_err(env.refund(), code(ClauseLockError::RefundNotYetAvailable));
    env.set_time(REVIEW_BY);
    env.refund().unwrap();
    expect_err(env.approve(), code(ClauseLockError::WrongState));
}

#[test]
fn approved_can_never_refund() {
    let mut env = Env::new();
    env.create().unwrap();
    env.accept().unwrap();
    env.submit().unwrap();
    env.set_time(REVIEW_BY - 1);
    env.approve().unwrap();
    for t in [REVIEW_BY, REVIEW_BY + 1, REVIEW_BY + 365 * 86_400] {
        env.set_time(t);
        expect_err(env.refund(), code(ClauseLockError::ApprovedCannotRefund));
    }
    let s = env.sponsor.insecure_clone();
    expect_err(env.cancel_as(&s), code(ClauseLockError::WrongState));
    env.pay().unwrap();
}

#[test]
fn sponsor_cancel_only_before_acceptance() {
    let mut env = Env::new();
    env.create().unwrap();
    let s = env.sponsor.insecure_clone();
    let before = env.lamports(&s.pubkey());
    env.cancel_as(&s).unwrap();
    assert_eq!(env.lamports(&s.pubkey()), before + AMOUNT - 5000);

    let mut env = Env::new();
    env.create().unwrap();
    env.accept().unwrap();
    let s = env.sponsor.insecure_clone();
    expect_err(env.cancel_as(&s), code(ClauseLockError::WrongState));
}

#[test]
fn terms_fields_unchanged_through_lifecycle() {
    let mut env = Env::new();
    env.create().unwrap();
    let a = env.state();
    env.accept().unwrap();
    env.submit().unwrap();
    env.approve().unwrap();
    env.pay().unwrap();
    let b = env.state();
    assert_eq!(
        (a.sponsor, a.contributor, a.amount, a.accept_by, a.submit_by, a.review_by, a.refund_policy, a.doc_digest, a.terms_hash),
        (b.sponsor, b.contributor, b.amount, b.accept_by, b.submit_by, b.review_by, b.refund_policy, b.doc_digest, b.terms_hash)
    );
}
