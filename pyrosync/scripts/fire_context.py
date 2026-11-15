"""Bounded upstream requests for the incident briefing."""
import csv
from datetime import date, timedelta
from functools import lru_cache
import io
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlencode
from urllib.request import Request, urlopen

FIRMS = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv'
PERIMETERS = ('https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/'
              'WFIGS_Interagency_Perimeters/FeatureServer/0/query')
OVERPASS = 'https://overpass-api.de/api/interpreter'
ROADS = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation_LargeScale/MapServer'
WATER = 'https://hydro.nationalmap.gov/arcgis/rest/services/NHDPlus_HR/MapServer'
STRUCTURES = 'https://carto.nationalmap.gov/arcgis/rest/services/structures/MapServer'
WEATHER_FIELDS = ('wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'relative_humidity_2m')


def retrieve(url, *, limit=400_000):
    with urlopen(Request(url, headers={'User-Agent': 'SpatialSequencers/1.0'}),
                 timeout=8) as response:
        payload = response.read(limit + 1)
    if len(payload) > limit:
        raise ValueError('Context response is too large. Zoom in for a smaller area.')
    return payload


def query(endpoint, params):
    return json.loads(retrieve(f'{endpoint}?{urlencode(params)}'))


def last_day(start):
    return min(start + timedelta(days=15), date.today())


@lru_cache(maxsize=24)
def weather(bounds, start):
    west, south, east, north = bounds
    end = last_day(start)
    location = {'latitude': round((south + north) / 2, 2), 'longitude': round((west + east) / 2, 2)}
    params = {**location, 'hourly': ','.join(WEATHER_FIELDS), 'wind_speed_unit': 'mph',
              'timeformat': 'unixtime', 'timezone': 'GMT', 'start_date': start, 'end_date': end}
    if start >= date.today() - timedelta(days=31):
        endpoint = 'https://api.open-meteo.com/v1/forecast'
        source = 'Open-Meteo model'
    else:
        endpoint = 'https://archive-api.open-meteo.com/v1/archive'
        params['models'] = 'era5'
        source = 'ERA5 via Open-Meteo'
    hourly = query(endpoint, params).get('hourly')
    if not hourly:
        raise ValueError('Hourly weather is unavailable for this date or area.')
    return {'source': source, **location, 'hours': list(zip(
        hourly['time'], *(hourly[field] for field in WEATHER_FIELDS), strict=True))}


@lru_cache(maxsize=24)
def fires(bounds, start):
    key = os.getenv('FIRMS_MAP_KEY', '')
    if not re.fullmatch(r'[a-fA-F0-9]{32}', key):
        raise ValueError('Set FIRMS_MAP_KEY in Docker for MODIS detections outside the bundled archive.')
    area = ','.join(map(str, bounds))
    end = last_day(start)

    def fetch(offset):
        day = start + timedelta(days=offset)
        days = min(5, (end - day).days + 1)
        source = 'MODIS_NRT' if day >= date.today() - timedelta(days=60) else 'MODIS_SP'
        try:
            raw = retrieve(f'{FIRMS}/{key}/{source}/{area}/{days}/{day}', limit=500_000)
        except OSError:
            raise ValueError('NASA FIRMS detections are unavailable for this date or area.') from None
        rows = csv.DictReader(io.StringIO(raw.decode()))
        if not rows.fieldnames or not {'latitude', 'acq_time', 'acq_date'}.issubset(rows.fieldnames):
            raise ValueError('NASA FIRMS did not return MODIS data. Check the key and date coverage.')
        return [
            [float(row['latitude']), float(row['longitude']), row['acq_date'],
             row['acq_time'].zfill(4), row['satellite'], int(row['confidence']),
             float(row['frp']), int(row.get('type') or 0)]
            for row in rows if str(start) <= row['acq_date'] <= str(end)
        ]

    with ThreadPoolExecutor(max_workers=4) as pool:
        points = [row for chunk in pool.map(fetch, range(0, (end - start).days + 1, 5))
                  for row in chunk]
    return {'start': str(start), 'end': str(end), 'points': points}


@lru_cache(maxsize=24)
def perimeters(bounds, start):
    result = query(PERIMETERS, {
        'where': (f"poly_PolygonDateTime >= TIMESTAMP '{start - timedelta(days=30)} 00:00:00' "
                  f"AND poly_PolygonDateTime < TIMESTAMP '{last_day(start) + timedelta(days=1)} 00:00:00'"),
        'geometry': ','.join(map(str, bounds)),
        'geometryType': 'esriGeometryEnvelope', 'inSR': 4326, 'outSR': 4326,
        'outFields': 'poly_IncidentName,poly_IRWINID,poly_PolygonDateTime',
        'orderByFields': 'poly_PolygonDateTime DESC', 'resultRecordCount': 100,
        'maxAllowableOffset': 0.0003, 'f': 'geojson',
    })
    if not isinstance(result.get('features'), list):
        raise ValueError('NIFC perimeters are unavailable.')
    return result


def nearby_us(latitude, longitude):
    layers = (
        ('Roads', ROADS, 2, 'NAME'),
        ('Water', WATER, 3, 'GNIS_NAME'),
        ('Water', WATER, 9, 'GNIS_NAME'),
        ('Buildings', STRUCTURES, 51, 'NAME'),
        ('Buildings', STRUCTURES, 72, 'NAME'),
    )

    def names(layer):
        _, service, layer_id, field = layer
        try:
            data = query(f'{service}/{layer_id}/query', {
                'where': f"{field} IS NOT NULL AND {field} <> ' '",
                'geometry': f'{longitude},{latitude}', 'geometryType': 'esriGeometryPoint',
                'inSR': 4326, 'distance': 2000, 'units': 'esriSRUnit_Meter',
                'returnGeometry': 'false', 'returnDistinctValues': 'true', 'outFields': field,
                'resultRecordCount': 12, 'f': 'json',
            })
            return {str(next(iter(feature['attributes'].values()))).strip()
                    for feature in data['features'] if feature['attributes']}
        except (OSError, ValueError, KeyError):
            return None

    with ThreadPoolExecutor(max_workers=5) as pool:
        results = list(pool.map(names, layers))
    if all(result is None for result in results):
        return None
    groups = {'Roads': set(), 'Buildings': set(), 'Water': set()}
    for (group, *_), result in zip(layers, results, strict=True):
        groups[group].update(result or ())
    return {'source': 'U.S. Census and USGS', 'groups': {group: sorted(values - {''})[:5]
                                                        for group, values in groups.items()}}


def nearby_osm(latitude, longitude):
    area = f'around:2000,{latitude:.5f},{longitude:.5f}'
    statement = f'''[out:json][timeout:6];
    way["highway"]["name"]({area}); out tags 12;
    nwr["natural"="water"]({area}); out tags 12;
    way["waterway"~"river|stream"]({area}); out tags 12;
    nwr["building"]["name"]({area}); out tags 12;
    node["emergency"~"fire_hydrant|water_tank|suction_point"]({area}); out tags 12;'''
    data = query(OVERPASS, {'data': statement})
    if data.get('remark'):
        raise ValueError('The nearby map query did not finish.')
    groups = {'Roads': set(), 'Buildings': set(), 'Water': set()}
    for entry in data['elements']:
        tags = entry.get('tags', {})
        if 'highway' in tags:
            groups['Roads'].add(tags['name'])
        if 'building' in tags:
            groups['Buildings'].add(tags['name'])
        if any(key in tags for key in ('natural', 'waterway', 'emergency')):
            groups['Water'].add(tags.get('name') or (tags.get('emergency') or tags.get('waterway')
                                                     or tags['natural']).replace('_', ' '))
    return {'source': 'OpenStreetMap', 'groups': {group: sorted(names)[:5] for group, names in groups.items()}}


@lru_cache(maxsize=32)
def nearby(bounds):
    west, south, east, north = bounds
    if east - west > 0.1 or north - south > 0.1:
        raise ValueError('Select a hotspot for nearby features.')
    latitude, longitude = (south + north) / 2, (west + east) / 2
    if -124.8 <= longitude <= -66.9 and 24.5 <= latitude <= 49.3:
        result = nearby_us(latitude, longitude)
        if result is not None:
            return result
    return nearby_osm(latitude, longitude)


def lookup_context(route, bounds, start):
    if route == '/nearby':
        return nearby(bounds)
    return {'/weather': weather, '/fires': fires, '/perimeters': perimeters}[route](bounds, start)
