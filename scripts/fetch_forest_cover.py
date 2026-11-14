"""Refresh the fixed-year World Bank / FAO forest-area snapshot (stdlib only)."""
import json
from pathlib import Path
from urllib.request import urlopen

YEAR = 2023
URL = ("https://api.worldbank.org/v2/country/all/indicator/AG.LND.FRST.ZS"
       f"?format=json&date={YEAR}&per_page=400")

if __name__ == "__main__":
    with urlopen(URL, timeout=60) as response:
        metadata, rows = json.load(response)
    if metadata['pages'] != 1:
        raise ValueError('Response is paginated; increase per_page before refreshing.')
    countries = {row['country']['value']: row['value'] for row in rows
                 if row['value'] is not None}
    if not countries or any(not 0 <= value <= 100 for value in countries.values()):
        raise ValueError('Invalid forest percentage response; keeping existing snapshot.')
    output = Path(__file__).resolve().parents[1] / 'public/data/forest_cover.json'
    output.write_text(json.dumps({
        'source': 'World Bank WDI / FAO', 'indicator': 'AG.LND.FRST.ZS',
        'url': 'https://data.worldbank.org/indicator/AG.LND.FRST.ZS',
        'year': YEAR, 'countries': countries
    }, indent=2) + '\n')
    print(f'Saved {len(countries)} forest-area records for {YEAR}.')
