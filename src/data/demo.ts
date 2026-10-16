import type { Band, Feature, Passage } from '../lib/types'

// Original, hand-authored examples. Bands are game fixtures, NOT model measurements.
// Every context contains exactly the text shown on its card.
const neutral = [
  'The bakery opens at seven every morning.',
  'She folded the clean towels and put them on the shelf.',
  'The bus stopped outside the municipal library.',
  'Add two tablespoons of olive oil and stir gently.',
  'He replaced the batteries in the kitchen clock.',
  'The printer needs another sheet of paper.',
  'A red bicycle was leaning against the wall.',
  'They painted the bedroom a soft shade of green.',
  'The invoice lists three items and a delivery charge.',
  'Her shoes made a squeaking sound on the polished floor.',
  'The football match ended in a draw.',
  'A stack of blue plates sat beside the sink.',
  'The cat stretched out on the warm windowsill.',
  'He sliced a pear into four equal pieces.',
  'The new desk fits neatly into the corner.',
  'Please bring your ticket to the reception desk.',
  'The festival begins with a performance by the school band.',
  'She walked the dog around the block after lunch.',
  'The book has twelve chapters and a short appendix.',
  'A cup of coffee costs three dollars at this café.',
  'He clicked the button to print a second copy.',
  'The gardener watered the tomato plants before breakfast.',
  'We moved the sofa to the other side of the room.',
  'The recipe calls for flour, eggs, and a pinch of salt.',
  'The train arrived at platform four.',
  'Her jacket had two large pockets and silver buttons.',
  'He tuned the guitar before the rehearsal began.',
  'The orange juice is in the lower drawer of the fridge.',
  'A small café occupies the ground floor of the building.',
  'The children lined up in pairs outside the classroom.',
  'She ran three laps around the athletics track.',
  'The meeting is scheduled for Tuesday afternoon.',
  'The elevator stopped on the sixth floor.',
  'A teaspoon of cinnamon gives the cake a warmer flavor.',
  'The shop sells handmade pottery and woven baskets.',
  'He hung his coat on the hook beside the door.',
  'const total = items.reduce((sum, item) => sum + item.price, 0);',
  'User: Can you convert 12 inches to centimeters? Assistant: 30.48 centimeters.',
  'The matrix has three rows, four columns, and a rank of two.',
  'HTTP 204 indicates that the request succeeded without a response body.',
  'The reaction releases heat when the two solutions are mixed.',
  'SELECT name, price FROM products ORDER BY price ASC;',
]

function makePassage(id: string, text: string, band: Band): Passage {
  const context = id.includes('-zero-')
    ? `He began a new page in the notebook with a small observation. ${text} Below it, he wrote the date and left room for another entry.`
    : id.startsWith('navigation')
      ? `She opened the logbook to the day's entry. ${text} At the foot of the page, she added the time and the weather conditions.`
      : id.startsWith('concealment')
        ? `At first, nothing about the scene seemed unusual. ${text} Only then did the small details begin to make sense.`
        : `The conversation turned to what to do next. ${text} Someone wrote it down before the group moved on to another question.`
  return { id, text, band, context }
}

function feature(
  id: string,
  title: string,
  description: string,
  cue: RegExp,
  starter: string,
  bands: Record<Exclude<Band, 0>, string[]>,
): Feature {
  return {
    id,
    title,
    description,
    cue,
    starter: makePassage(`${id}-starter`, starter, 50),
    passages: [
      ...neutral.map((text, index) =>
        makePassage(`${id}-zero-${index}`, text, 0),
      ),
      ...Object.entries(bands).flatMap(([band, texts]) =>
        texts.map((text, index) =>
          makePassage(`${id}-${band}-${index}`, text, Number(band) as Band),
        ),
      ),
    ],
  }
}

export const FEATURES: Feature[] = [
  feature(
    'uncertainty',
    'Room for doubt',
    'Hedging, uncertainty, and keeping more than one explanation open. Compare tentative language with a confident statement about the same topic.',
    /\b(perhaps|maybe|might|may|could|possibly|probably|uncertain|uncertainty|unsure|doubt|doubts|tentative|tentatively|likely|seems|suggests|suspect|apparently|presumably|inconclusive|conceivable|plausible|possibly|confidence|guess|speculative)\b/i,
    'The café might still be open when we get there.',
    {
      50: [
        'Maybe we should take the later train.',
        'It looks like it might rain this afternoon.',
        'She probably left her notebook in the car.',
        'Perhaps a little more salt would help.',
        'The parcel may arrive before the weekend.',
        'I suspect he already knows the answer.',
        'They are likely to finish before dinner.',
        'It seems the shop has changed its opening hours.',
      ],
      90: [
        'The evidence suggests a link, though other explanations remain possible.',
        'It could be a coincidence; we do not have enough information yet.',
        'I am unsure whether the result will hold in a larger study.',
        'The estimate is tentative and may change with new observations.',
        'There is reason to doubt that this explanation is complete.',
        'We suspect a fault in the sensor, but that has not been confirmed.',
        'The pattern seems meaningful, although the sample is small.',
        'Perhaps the first explanation is right; perhaps we overlooked something.',
      ],
      95: [
        'The findings are inconclusive, and any interpretation remains tentative.',
        'We cannot confidently distinguish an effect from random variation.',
        'It is plausible, but by no means certain, that the two events are related.',
        'I would hesitate to call this proof; it may simply reflect a sampling error.',
        'My best guess is that it works, though my confidence is limited.',
        'The explanation is probably incomplete and possibly mistaken.',
        'Several accounts seem equally plausible, so our conclusion is provisional.',
        'One might infer a trend, but the uncertainty is still substantial.',
      ],
      99: [
        'Perhaps, although I remain unsure, this might be a plausible explanation.',
        'Our tentative hypothesis could be wrong; the evidence is still inconclusive.',
        'I suspect it may be true, but I cannot rule out several alternatives.',
        'Maybe the result suggests something real, or perhaps it is only noise.',
        'Any confident conclusion would be premature given this uncertainty.',
        'The claim seems plausible, yet considerable doubt remains about its accuracy.',
        'We can only offer a speculative estimate with very limited confidence.',
        'Presumably there is an explanation, though we are unsure which is likely.',
      ],
      99.9: [
        'Perhaps it might be possible, but I am deeply unsure and could easily be mistaken.',
        'Maybe, possibly, the evidence suggests a tentative answer; certainty is out of reach.',
        'I remain uncertain: this speculative hypothesis may or may not be plausible.',
        'Our confidence is low, our estimate tentative, and our conclusion still in doubt.',
        'It could perhaps be true, although the inconclusive evidence leaves us unsure.',
        'Possibly, but not necessarily; I suspect we should remain very uncertain.',
        'This is only a tentative guess, with substantial uncertainty and ample room for doubt.',
        'One might cautiously speculate, but any answer would remain uncertain and inconclusive.',
      ],
    },
  ),
  feature(
    'navigation',
    'Finding your bearings',
    'Navigation at sea: bearings, charts, beacons, and steering a vessel toward a destination. A broad topic can hide a more specific pattern.',
    /\b(compass|north|bearing|bearings|course|chart|charts|harbor|harbour|lighthouse|beacon|buoy|buoys|navigate|navigation|navigator|captain|heading|helm|starboard|port|channel|vessel|ship|sailor|sailors|nautical|latitude|longitude|sextant)\b/i,
    'We could see the lighthouse from the end of the beach.',
    {
      50: [
        'A little boat was tied to a post in the harbor.',
        'The lighthouse flashed twice against the evening sky.',
        'He kept an old compass in his coat pocket.',
        'The ship arrived just before sunrise.',
        'A red buoy bobbed gently on the water.',
        'The sailor came home with a bag full of postcards.',
        'A chart of the islands hung in the hotel lobby.',
        'The captain drank her tea on the upper deck.',
      ],
      90: [
        'The captain checked the compass before leaving the harbor.',
        'They followed the line of buoys into the narrow channel.',
        'He marked their position on the nautical chart.',
        'The lighthouse helped the crew find the entrance after dark.',
        'She adjusted the course to avoid the shallow water.',
        'The navigator measured their distance from the nearest island.',
        'They turned the vessel north as the coast disappeared.',
        'A beacon guided the fishing boats safely into port.',
      ],
      95: [
        'Using a compass and a chart, the navigator plotted a safer course.',
        'The captain took a bearing on the lighthouse and turned to starboard.',
        'They checked their latitude before entering the shipping channel.',
        'The vessel changed heading to keep the green buoy on its starboard side.',
        'The crew used two beacons to determine their position on the chart.',
        'At the helm, she steered north toward the harbor entrance.',
        'The navigator compared the compass bearing with the charted course.',
        'A sailor used a sextant to estimate their latitude at noon.',
      ],
      99: [
        'The navigator plotted the latitude and longitude, then set a compass course for port.',
        'At the helm, the captain checked her bearing against the lighthouse beacon.',
        'Keep the buoy to starboard and follow the charted channel into the harbor.',
        'The ship corrected its heading after the navigator took a fresh compass bearing.',
        'Using the nautical chart, the crew plotted a course between the two beacons.',
        'The navigator used a sextant and compass to guide the vessel north.',
        'The captain compared the chart, bearing, and buoy positions before entering port.',
        'A lighthouse bearing placed the vessel just west of the marked navigation channel.',
      ],
      99.9: [
        'The navigator checked latitude and longitude, plotted a compass bearing, and steered the ship toward the harbor beacon.',
        'At the helm, the captain set a northerly course, keeping the channel buoy to starboard and the lighthouse ahead.',
        'Using a sextant, nautical chart, and compass, the navigator guided the vessel safely into port.',
        'Plot the bearing on the nautical chart, correct the heading, and follow the buoys through the harbor channel.',
        'The ship’s navigator took a compass bearing from the lighthouse, checked the chart, and set a new course.',
        'The captain steered the vessel north by compass, using the charted buoys and beacon to navigate the channel.',
        'With latitude and longitude marked on the chart, the sailor adjusted the helm toward the harbor’s navigation beacon.',
        'A compass bearing and a sextant reading let the navigator plot the ship’s course past the lighthouse into port.',
      ],
    },
  ),
  feature(
    'concealment',
    'Beneath the surface',
    'Concealing something and discovering what was hidden: secret compartments, disguises, and clues that reveal another layer.',
    /\b(hidden|hide|hiding|hid|secret|secretly|concealed|conceal|concealment|disguise|disguised|camouflage|camouflaged|unseen|unnoticed|underneath|beneath|behind|buried|covered|compartment|false|revealed|reveal|obscured|masked|mask|invisible)\b/i,
    'She found a small note tucked behind the photograph.',
    {
      50: [
        'The spare key was hidden under a flowerpot.',
        'He kept the birthday present behind the sofa.',
        'There was a little door beneath the staircase.',
        'She covered the bowl with a clean cloth.',
        'The path was obscured by fallen leaves.',
        'They hid the biscuits on the highest shelf.',
        'The cat was hiding underneath the bed.',
        'He noticed a coin buried in the sand.',
      ],
      90: [
        'A false bottom in the drawer concealed a bundle of letters.',
        'The entrance was hidden behind a curtain of ivy.',
        'She wore a disguise so that nobody would recognize her.',
        'The message was concealed between the lines of an ordinary letter.',
        'A secret compartment opened when he pressed the wooden panel.',
        'Fresh paint covered the outline of a door beneath it.',
        'The animal’s camouflage made it almost invisible against the bark.',
        'Behind the cheerful smile, she hid a growing sense of unease.',
      ],
      95: [
        'Behind the false wall, a hidden room held the missing documents.',
        'The secret message was disguised as a harmless shopping list.',
        'He uncovered a concealed compartment beneath the ordinary floorboards.',
        'The mask concealed an identity that had gone unnoticed for years.',
        'A hidden catch revealed a second drawer beneath the first.',
        'The camouflaged doorway remained invisible until the light shifted.',
        'She hid the secret in plain sight, disguised as a familiar decoration.',
        'Removing the cover revealed a concealed mechanism inside the box.',
      ],
      99: [
        'A hidden latch behind the mirror revealed a secret compartment beneath the shelf.',
        'The ordinary book concealed a secret message, itself disguised by an invisible code.',
        'Behind the disguise lay a carefully hidden identity that no one had suspected.',
        'A false panel masked the concealed entrance to a secret underground room.',
        'The clue was hidden underneath the lining, inside a compartment disguised as a seam.',
        'The camouflage concealed a doorway, and the doorway concealed a second secret.',
        'Beneath the surface, a hidden pattern revealed the message they had tried to conceal.',
        'He removed the false cover and revealed a secret that had remained hidden for decades.',
      ],
      99.9: [
        'Behind a disguised panel, a hidden latch revealed a secret compartment concealed beneath the false floor.',
        'The secret was hidden inside a concealed compartment, itself camouflaged behind an ordinary-looking wall.',
        'An invisible message revealed the hidden entrance, where a false panel concealed another secret.',
        'Beneath the disguise lay a hidden identity; behind that identity, an even more carefully concealed secret.',
        'The hidden mechanism revealed a secret drawer beneath a false bottom, all concealed behind the mirror.',
        'A camouflaged cover masked the secret compartment, keeping the hidden contents invisible and unnoticed.',
        'She revealed the concealed passage behind the false wall and the secret chamber hidden beneath it.',
        'The disguise hid a secret message, the message revealed a hidden latch, and the latch opened a concealed compartment.',
      ],
    },
  ),
]

export function getFeature(id: string): Feature {
  const result = FEATURES.find((item) => item.id === id)
  if (!result) throw new Error('Unknown puzzle feature.')
  return result
}
