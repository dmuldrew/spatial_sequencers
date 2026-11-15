"""Serve bounded, date-specific MODIS/H3 blocks for the Docker map."""
from collections import OrderedDict
from datetime import date
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import re
from tempfile import TemporaryDirectory
from threading import Event, Lock
from urllib.parse import parse_qs, urlsplit

import h3

from midwest_archive import Archive, MAX_RAW_BYTES, composite_window
from fire_context import lookup_context
from prepare_midwest_blocks import latitude_at, mercator_y, prepare, study_bounds

COVERAGE = {'west': -124.8, 'south': 24.5, 'east': -66.9, 'north': 49.3}
DEFAULT_DATE = date(2024, 7, 11)
BLOCK_ROUTE = re.compile(r'/blocks/(-?\d{1,2})-(-?\d{1,2})(/plan)?')
JOB_ROUTE = re.compile(r'/cancel/([a-f0-9-]{36})')
CACHE_ROOT = Path(os.environ.get('MIDWEST_CACHE', '/tmp/midwest-cache'))
ARCHIVE = Archive(CACHE_ROOT / 'rasters')
RESULTS = CACHE_ROOT / 'blocks-v1'
RESULTS.mkdir(parents=True, exist_ok=True)
WORK = Lock()
JOBS = {}
JOBS_LOCK = Lock()
PLANS = OrderedDict()


def bounds_for(x, y):
    west, south, east, north = study_bounds()
    width = (east - west) / 2
    height = (mercator_y(north) - mercator_y(south)) / 2
    x0 = west - 1.5 * width
    y0 = mercator_y(south) - 1.5 * height
    block = (x0 + x * width, latitude_at(y0 + y * height),
             x0 + (x + 1) * width, latitude_at(y0 + (y + 1) * height))
    if (block[0] >= COVERAGE['east'] or block[2] <= COVERAGE['west']
            or block[1] >= COVERAGE['north'] or block[3] <= COVERAGE['south']):
        raise ValueError('This block is outside the contiguous-US coverage.')
    return block


def expanded(bounds):
    # Include the entire source area for H3 cells that cross a block edge.
    west, south, east, north = bounds
    return max(-180, west - 0.08), max(-85, south - 0.08), min(180, east + 0.08), min(85, north + 0.08)


def overlaps(cell, bounds):
    lat, lon = zip(*h3.cell_to_boundary(cell['id']))
    west, south, east, north = bounds
    return min(lat) < north and max(lat) > south and min(lon) < east and max(lon) > west


def result_path(key):
    return RESULTS / f'{key}.json'


def save_result(key, block_id, cells):
    path = result_path(key)
    payload = json.dumps({'id': block_id, 'cells': cells}, separators=(',', ':')).encode()
    if len(payload) > 1_000_000:
        raise ValueError('The prepared map block exceeds its size limit.')
    temp = path.with_suffix('.tmp')
    temp.write_bytes(payload)
    temp.replace(path)
    files = sorted(RESULTS.glob('*.json'), key=lambda item: item.stat().st_mtime)
    for old in files[:-128]:
        old.unlink()
    return payload


def parse_bounds(value, max_width=5, max_height=5):
    west, south, east, north = map(float, value.split(','))
    width = (east - west) * math.cos(math.radians((south + north) / 2))
    if not (-180 <= west < east <= 180 and -85 <= south < north <= 85
            and 0 < width <= max_width and north - south <= max_height):
        raise ValueError('Invalid map data bounds.')
    return west, south, east, north


def request_date(options):
    day = date.fromisoformat(options.get('date', [DEFAULT_DATE.isoformat()])[0])
    if not date(2000, 2, 18) <= day <= date.today():
        raise ValueError('Date is outside the MODIS observation period.')
    return day


def plan_block(key, bounds, start, canceled):
    if result_path(key).exists():
        return {'sourceBytes': 0}
    dates_by_tile, sources, missing = ARCHIVE.plan(expanded(bounds), start, canceled)
    PLANS[key] = (dates_by_tile, sources)
    PLANS.move_to_end(key)
    if len(PLANS) > 24:
        PLANS.popitem(last=False)
    return {'sourceBytes': missing}


def build_block(key, block_id, bounds, budget, canceled):
    path = result_path(key)
    if path.exists():
        path.touch()
        return path.read_bytes()
    plan = PLANS.get(key)
    if plan is None:
        raise ValueError('The download plan expired. Retry the map update.')
    dates_by_tile, sources = plan
    west, south, east, north = bounds
    latitude, longitude = (south + north) / 2, (west + east) / 2
    zone = min(60, math.floor((longitude + 180) / 6) + 1)
    conus = (COVERAGE['west'] <= longitude <= COVERAGE['east']
             and COVERAGE['south'] <= latitude <= COVERAGE['north'])
    crs = 'EPSG:5070' if conus else f'EPSG:{(32600 if latitude >= 0 else 32700) + zone}'
    with TemporaryDirectory(prefix='roaming-modis-') as scratch:
        directory = Path(scratch)
        ARCHIVE.materialize(sources, directory, budget, canceled)
        if canceled.is_set():
            raise ValueError('Download canceled.')
        data = prepare(directory, expanded(bounds), dates_by_tile, allow_empty=True,
                       bands_by_tile=dates_by_tile, crs=crs)
    if canceled.is_set():
        raise ValueError('Download canceled.')
    return save_result(key, block_id, [cell for cell in data['cells'] if overlaps(cell, bounds)])


class Handler(BaseHTTPRequestHandler):
    def respond(self, status, data):
        if not isinstance(data, bytes):
            data = json.dumps(data).encode()
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        cancel = JOB_ROUTE.fullmatch(self.path)
        if not cancel:
            return self.respond(404, {'error': 'Unknown map endpoint.'})
        with JOBS_LOCK:
            event = JOBS.get(cancel[1])
            if event:
                event.set()
        return self.respond(200, {'canceled': bool(event)})

    def do_GET(self):
        url = urlsplit(self.path)
        options = parse_qs(url.query)
        if url.path == '/config':
            return self.respond(200, {'coverage': COVERAGE})
        if url.path in ('/fires', '/weather', '/perimeters', '/nearby'):
            try:
                bounds = parse_bounds(options['bounds'][0])
                return self.respond(200, lookup_context(url.path, bounds, request_date(options)))
            except (ValueError, KeyError, OSError) as error:
                return self.respond(502, {'error': str(error) if isinstance(error, ValueError)
                                          else 'The map context provider is unavailable.'})
        match = BLOCK_ROUTE.fullmatch(url.path)
        if not match:
            return self.respond(404, {'error': 'Unknown map endpoint.'})
        job = options.get('job', [''])[0]
        if not re.fullmatch(r'[a-f0-9-]{36}', job):
            return self.respond(400, {'error': 'Missing map job identifier.'})
        canceled = Event()
        with JOBS_LOCK:
            JOBS[job] = canceled
        try:
            x, y = int(match[1]), int(match[2])
            block_id = f'{x}-{y}'
            requested = request_date(options)
            custom = options.get('bounds', [None])[0]
            bounds = parse_bounds(custom, 1.6, 1.3) if custom else bounds_for(x, y)
            composite, _ = composite_window(requested)
            key = block_id if custom is None and composite == DEFAULT_DATE else sha256(
                f'{block_id}:{bounds}:{composite}'.encode()).hexdigest()
            with WORK:
                if canceled.is_set():
                    raise ValueError('Download canceled.')
                if match[3]:
                    response = plan_block(key, bounds, requested, canceled)
                else:
                    budget = int(options.get('budget', ['0'])[0])
                    if not 0 <= budget <= MAX_RAW_BYTES:
                        raise ValueError('Invalid source download budget.')
                    response = build_block(key, block_id, bounds, budget, canceled)
            self.respond(200, response)
        except (ValueError, OSError, RuntimeError, KeyError) as error:
            self.respond(502, {'error': str(error) if isinstance(error, ValueError)
                               else 'The MODIS block could not be prepared. Try again.'})
        finally:
            with JOBS_LOCK:
                JOBS.pop(job, None)


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 3001), Handler).serve_forever()
