// Tour narration text, shared by the flyby (js/flyby.js) and the narration build step
// (scripts/build_tour_narration.py), which renders every line returned by
// allTourLines() to an audio clip. Keep all wording here so the two never disagree.

// Guided fire hotspot tour. Each stop sits on the densest H3 resolution-3 hexagon of its
// region in the 2001-2025 data; the spoken numbers are read from the data at arrival,
// the context sentence explains why fire is common there.
export const TOUR_STOPS = [
  {
    id: 'california', name: "Northern California's Klamath Mountains", lat: 41.83, lon: -123.67,
    // UC Berkeley / PNAS 2022: Indigenous burning shaped Klamath forests for a millennium.
    context: [
      'Karuk and Yurok cultural burning kept these forests open for at least a thousand years.',
      'A century of fire suppression let them grow dense, and with a warming climate, fires here now burn larger.'
    ]
  },
  {
    id: 'brazil', name: "Maranhão, in Brazil's Cerrado", lat: -6.23, lon: -45.14,
    // MATOPIBA studies: Maranhão and Tocantins lead Cerrado burned area; fires track fresh clearing.
    context: [
      'Maranhão sits on the Cerrado\'s soy and cattle frontier, where it and Tocantins burn the most of any states in the biome.',
      'Most fires here follow freshly cleared land, set in the dry season from July to October.'
    ]
  },
  {
    id: 'northern-savanna', name: "Africa's northern savanna", lat: 5.57, lon: 28.29,
    // Andela et al., Science 2017: savanna burned area fell as cropland and livestock fragmented grassland.
    context: [
      'Each dry season, from November to March, people burn these grasslands to clear fields and renew grazing.',
      'Across Africa\'s northern savannas, burned area has fallen as farms and herds break up the grass that carries fire.'
    ]
  },
  {
    id: 'angola', name: "Angola's miombo woodlands", lat: -9.42, lon: 17.97,
    // Catarino et al. 2022: ~30% of Angola burns each year (MODIS 2001-2019); Africa ~70% of global burned area.
    context: [
      'Africa holds about 70 percent of the world\'s burned area, and roughly 30 percent of Angola burns every year.',
      'These are mostly small savanna and farm fires, not forest clearing.'
    ]
  },
  {
    id: 'yakutia', name: 'Yakutia, in eastern Siberia', lat: 62.32, lon: 127.33,
    // NASA Earth Observatory: 2021 was Sakha's record burn year in the MODIS era (~9.4 million ha).
    context: [
      'Larch forests on carbon-rich permafrost start burning soon after the snow melts.',
      'In 2021, Yakutia burned more than nine million hectares, its largest fire year in the satellite record.'
    ]
  },
  {
    id: 'laos', name: 'Northern Laos', lat: 19.72, lon: 102.31,
    // Lao air-quality reporting: shifting-cultivation burning; March-April haze; Jan-Apr burn ban (2025-26).
    context: [
      'Farmers burn hillside plots for shifting cultivation, and smoke haze peaks in March and April.',
      'Laos now bans outdoor burning from January to April to cut the haze.'
    ]
  },
  {
    id: 'kalimantan', name: 'Central Kalimantan, on Borneo', lat: -2.79, lon: 113.85,
    // Mongabay / CIFOR: failed Mega Rice Project drained peat; 2015 El Nino fires; canal blocking by the peat agency.
    context: [
      'The failed Mega Rice Project of the 1990s drained a million hectares of peat swamp here.',
      'In El Niño droughts like 2015 the dry peat smoulders for weeks; canals are now being blocked to rewet it.'
    ]
  },
  {
    id: 'north-australia', name: "Northern Australia's savannas", lat: -13.39, lon: 132.2,
    // WALFA studies: early dry-season burning cut late-season fires and emissions by ~38%.
    context: [
      'Rangers, many of them Indigenous, burn early in the dry season, when fires are cool and patchy.',
      'Projects like West Arnhem Land have cut late-season fires and emissions by more than a third.'
    ]
  }
];

export const TOUR_INTRO = [
  'Welcome aboard PyroSat-1. We are touring the world\'s fire hotspots.',
  'The hexagons show 25 years of satellite fire detections: bright yellow means the most fire, dark purple the least. Orange towers are a recent week\'s most intense fires.',
  'Listen: crackle and higher notes mean more fire, a tense chord means fire is rising, and a bell marks a new fire season.',
  'Press F at any time for the fire history below.'
];

export const TOUR_TIP = 'Tip: click Enable Audio to hear this narration and the fire sounds.';

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

export const firstStopLine = (stop) => `First stop: ${stop.name}.`;
export const nextStopLine = (stop) => `Next stop: ${stop.name}.`;
export const resumeLine = (stop) => `Resuming the tour. Next stop: ${stop.name}.`;
export const arrivalLine = (stop) => `Now over ${stop.name}.`;

// One sentence about the featured hexagon. Numbers are formatted for en-US explicitly so
// the text (and therefore the pre-rendered clip it maps to) is the same in every locale.
export function dataLine({ detections, trendPercent, peakMonth, startYear }) {
  let line = `The hexagon at the centre of our circle logged ${Math.round(detections).toLocaleString('en-US')} fires since ${startYear}`;
  if (peakMonth >= 1) line += `, peaking in ${MONTH_NAMES[peakMonth - 1]}`;
  if (trendPercent === null || trendPercent === undefined) return `${line}.`;
  if (Math.abs(trendPercent) < 10) return `${line}, with a steady trend, so the chord is calm.`;
  if (trendPercent > 0) return `${line}, up ${trendPercent} percent in the last decade, hence the tense chord.`;
  return `${line}, down ${Math.abs(trendPercent)} percent in the last decade, so the chord stays calm.`;
}

// Percent change from trend_log2, rounded the way the flyby rounds it.
export const trendPercentFromLog2 = (t) => (Number.isFinite(t) ? Math.round((Math.pow(2, t) - 1) * 100) : null);

// Every line the tour can speak, given each stop's featured-hexagon values
// ({ [stopId]: { detections, trend_log2, peak_month } }) and the data's start year.
export function allTourLines(stopData = {}, startYear = '2001') {
  const lines = [TOUR_TIP, ...TOUR_INTRO];
  for (const stop of TOUR_STOPS) {
    lines.push(firstStopLine(stop), nextStopLine(stop), resumeLine(stop), arrivalLine(stop), ...stop.context);
    const d = stopData[stop.id];
    if (d) {
      lines.push(dataLine({
        detections: d.detections,
        trendPercent: trendPercentFromLog2(d.trend_log2),
        peakMonth: d.peak_month,
        startYear
      }));
    }
  }
  return [...new Set(lines)];
}
