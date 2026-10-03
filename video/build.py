#!/usr/bin/env python3
"""Mux out/raw.webm + per-scene voiceover (offset by scene start) + burned-in captions -> docs/pitch.mp4."""
import json, os, re, subprocess, pathlib
D = pathlib.Path(__file__).parent
O = D/os.environ.get("OUT", "out")
scenes = json.load(open(O/'scenes.json'))
LEAD = 0.3  # voice starts this long after the scene's visual

def t2s(t): h, m, s = t.replace(',', '.').split(':'); return int(h)*3600 + int(m)*60 + float(s)
def s2t(x): h = int(x//3600); m = int(x%3600//60); s = x%60; return f"{h:02}:{m:02}:{s:06.3f}".replace('.', ',')

def split(text, a, b, maxc=62):
    """Split a long cue into chunks at commas/colons/spaces, timing proportional to characters."""
    if len(text) <= maxc: return [(a, b, text)]
    words, chunks, cur = text.split(), [], ''
    for w in words:
        if cur and len(cur) + 1 + len(w) > maxc: chunks.append(cur); cur = w
        else: cur = f"{cur} {w}".strip()
        if cur.endswith((',', ':', ';')) and len(cur) > maxc*0.45: chunks.append(cur); cur = ''
    if cur: chunks.append(cur)
    if len(chunks) > 1 and len(chunks[-1]) < 18 and len(chunks[-2]) + len(chunks[-1]) < maxc + 16: chunks[-2:] = [chunks[-2] + ' ' + chunks[-1]]
    tot = sum(len(c) for c in chunks); out, t = [], a
    for c in chunks: d = (b-a)*len(c)/tot; out.append((t, t+d, c)); t += d
    return out

cues = []
for sc in scenes:
    srt = (O/f"tts/{sc['id']}.srt").read_text()
    for blk in srt.strip().split('\n\n'):
        lines = blk.strip().splitlines()
        a, b = [t2s(x.strip()) for x in lines[1].split('-->')]
        cues += split(' '.join(lines[2:]), sc['start']+LEAD+a, sc['start']+LEAD+b)
with open(O/'captions.srt', 'w') as f:
    for i, (a, b, t) in enumerate(cues, 1): f.write(f"{i}\n{s2t(a)} --> {s2t(b)}\n{t}\n\n")

inputs, filt = ['-i', str(O/'raw.webm')], []
for i, sc in enumerate(scenes, 1):
    inputs += ['-i', str(O/f"tts/{sc['id']}.mp3")]
    ms = int((sc['start']+LEAD)*1000); filt.append(f"[{i}:a]adelay={ms}|{ms},aresample=48000[a{i}]")
n = len(scenes)
filt.append(''.join(f"[a{i}]" for i in range(1, n+1)) + f"amix=inputs={n}:normalize=0,loudnorm=I=-16:TP=-1.5[aout]")
style = "FontName=DejaVu Sans,FontSize=19,PrimaryColour=&H00FFFFFF,BackColour=&H99000000,BorderStyle=3,Outline=6,Shadow=0,MarginV=22,Alignment=2"
filt.append(f"[0:v]fps=30,subtitles={O/'captions.srt'}:force_style='{style}',format=yuv420p[vout]")
end = scenes[-1]['end'] + 0.6
out = D.parent/'docs'/os.environ.get('MP4', 'pitch.mp4')
cmd = ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', *inputs, '-filter_complex', ';'.join(filt), '-map', '[vout]', '-map', '[aout]',
       '-t', f"{end:.2f}", '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-tune', 'stillimage', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', str(out)]
subprocess.run(cmd, check=True)
print(out, subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration,size', '-of', 'csv=p=0', str(out)], capture_output=True, text=True).stdout.strip())
