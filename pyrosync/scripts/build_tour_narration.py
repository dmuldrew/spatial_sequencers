"""Render the flyby tour narration to MP3 clips with Piper text-to-speech.

iOS Safari cannot play speechSynthesis and Web Audio at the same time, so the tour's
spoken lines are pre-rendered and played through Web Audio alongside the fire sounds.
Every line comes from public/js/tour-content.js (via scripts/tour_lines.mjs), including
the per-stop data sentence, which is filled in from the featured resolution-3 hexagon in
public/data/global-fire/lod-r3.arrow. Re-run after changing the tour text or the data.

Outputs public/data/tour/narration.json ({"lines": {text: "clips/<hash>.mp3"}}) and the
clips. Unchanged lines keep their existing clips; clips no longer referenced are removed.

Voice: Piper en_US-ljspeech-high, trained on the public-domain LJ Speech dataset
(https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/ljspeech/high).

Usage:
    pip install piper-tts lameenc pyarrow h3
    python3 scripts/build_tour_narration.py --voice /path/to/en_US-ljspeech-high.onnx
"""
import argparse
import hashlib
import io
import json
import re
import subprocess
import tempfile
import wave
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
VOICE_NOTE = 'Piper en_US-ljspeech-high (LJ Speech dataset, public domain)'


def node_json(*args):
    out = subprocess.run(['node', str(PROJECT / 'scripts/tour_lines.mjs'), *args],
                         check=True, capture_output=True, text=True, cwd=PROJECT)
    return json.loads(out.stdout)


def stop_data(data_dir, stops):
    """Featured resolution-3 hexagon values for each stop, as the flyby reads them."""
    import h3
    import pyarrow.ipc as ipc

    table = ipc.open_file(str(data_dir / 'lod-r3.arrow')).read_all()
    cols = {name: table.column(name).to_pylist() for name in ('h3_index', 'detections', 'trend_log2', 'peak_month')}
    rows = {format(cell, 'x'): i for i, cell in enumerate(cols['h3_index'])}
    result = {}
    for stop in stops:
        i = rows.get(h3.latlng_to_cell(stop['lat'], stop['lon'], 3))
        if i is None:
            print(f"warning: no resolution-3 data under stop {stop['id']}")
            continue
        result[stop['id']] = {
            'detections': cols['detections'][i],
            'trend_log2': cols['trend_log2'][i],
            'peak_month': cols['peak_month'][i],
        }
    return result


def synthesize_mp3(voice, text, bitrate):
    import lameenc

    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wav:
        voice.synthesize_wav(text, wav)
    buf.seek(0)
    with wave.open(buf, 'rb') as wav:
        rate, channels, frames = wav.getframerate(), wav.getnchannels(), wav.readframes(wav.getnframes())
        seconds = wav.getnframes() / rate
    encoder = lameenc.Encoder()
    encoder.set_bit_rate(bitrate)
    encoder.set_in_sample_rate(rate)
    encoder.set_channels(channels)
    encoder.set_quality(2)
    return encoder.encode(frames) + encoder.flush(), seconds


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--voice', type=Path, required=True, help='Piper .onnx voice (with .onnx.json beside it)')
    parser.add_argument('--data-dir', type=Path, default=PROJECT / 'public/data/global-fire')
    parser.add_argument('--out-dir', type=Path, default=PROJECT / 'public/data/tour')
    parser.add_argument('--bitrate', type=int, default=48, help='MP3 kbit/s (default 48, mono)')
    parser.add_argument('--force', action='store_true', help='Re-render every clip')
    args = parser.parse_args()

    from piper import PiperVoice

    manifest = json.loads((args.data_dir / 'manifest.json').read_text())
    start_year = (re.findall(r'\d{4}', manifest.get('periodLabel', '')) or ['2001'])[0]
    stops = node_json('stops')
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as tmp:
        json.dump({'startYear': start_year, 'stops': stop_data(args.data_dir, stops)}, tmp)
    lines = node_json('lines', tmp.name)
    Path(tmp.name).unlink()

    clips_dir = args.out_dir / 'clips'
    clips_dir.mkdir(parents=True, exist_ok=True)
    voice = PiperVoice.load(str(args.voice))
    mapping, rendered, total_seconds = {}, 0, 0.0
    for text in lines:
        name = hashlib.sha1(text.encode('utf-8')).hexdigest()[:12] + '.mp3'
        path = clips_dir / name
        if args.force or not path.exists():
            mp3, seconds = synthesize_mp3(voice, text, args.bitrate)
            path.write_bytes(mp3)
            rendered += 1
            total_seconds += seconds
        mapping[text] = f'clips/{name}'

    keep = {Path(v).name for v in mapping.values()}
    removed = 0
    for old in clips_dir.glob('*.mp3'):
        if old.name not in keep:
            old.unlink()
            removed += 1

    (args.out_dir / 'narration.json').write_text(json.dumps({
        'schemaVersion': 1,
        'voice': VOICE_NOTE,
        'format': f'mp3 mono {args.bitrate} kbit/s',
        'lines': mapping,
    }, ensure_ascii=False, indent=1) + '\n')
    size = sum(p.stat().st_size for p in clips_dir.glob('*.mp3'))
    print(f'{len(mapping)} lines, {rendered} rendered ({total_seconds:.0f} s of audio), {removed} removed, '
          f'{size / 1e6:.2f} MB of clips')


if __name__ == '__main__':
    main()
