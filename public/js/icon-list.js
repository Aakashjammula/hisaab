// Curated Lucide icons for categories. The Worker only accepts names from this list,
// and scripts/vendor.mjs builds public/icons.svg from it. Add an icon = add one line + `npm run vendor`.

export const CATEGORY_ICONS = [
  // Food & drink
  ['utensils', 'Food & drink', 'food meal dinner lunch restaurant eat'],
  ['coffee', 'Food & drink', 'coffee cafe tea chai'],
  ['pizza', 'Food & drink', 'pizza fast food'],
  ['sandwich', 'Food & drink', 'snack sandwich breakfast'],
  ['soup', 'Food & drink', 'soup bowl'],
  ['salad', 'Food & drink', 'salad healthy'],
  ['ice-cream-cone', 'Food & drink', 'ice cream dessert sweets'],
  ['cake', 'Food & drink', 'cake birthday bakery'],
  ['cookie', 'Food & drink', 'cookie snacks biscuit'],
  ['apple', 'Food & drink', 'fruit apple'],
  ['beer', 'Food & drink', 'beer drinks bar alcohol'],
  ['wine', 'Food & drink', 'wine drinks party'],
  ['cup-soda', 'Food & drink', 'soda juice drinks'],
  ['chef-hat', 'Food & drink', 'cooking chef'],
  ['milk', 'Food & drink', 'milk dairy'],
  ['egg', 'Food & drink', 'egg breakfast'],
  // Groceries & shopping
  ['shopping-cart', 'Shopping', 'groceries grocery supermarket mart'],
  ['shopping-basket', 'Shopping', 'basket vegetables market'],
  ['shopping-bag', 'Shopping', 'shopping bag clothes mall'],
  ['store', 'Shopping', 'store shop'],
  ['shirt', 'Shopping', 'clothes clothing shirt fashion'],
  ['footprints', 'Shopping', 'shoes footwear'],
  ['watch', 'Shopping', 'watch accessories'],
  ['glasses', 'Shopping', 'glasses spectacles'],
  ['gem', 'Shopping', 'jewellery jewelry gold'],
  ['gift', 'Shopping', 'gift present'],
  ['package', 'Shopping', 'package delivery amazon flipkart online'],
  ['tag', 'Shopping', 'tag other misc'],
  ['smartphone', 'Shopping', 'phone mobile gadget'],
  ['laptop', 'Shopping', 'laptop computer electronics'],
  ['headphones', 'Shopping', 'headphones audio'],
  ['camera', 'Shopping', 'camera photo'],
  // Transport
  ['car', 'Transport', 'car'],
  ['car-taxi-front', 'Transport', 'taxi cab uber ola'],
  ['bus', 'Transport', 'bus'],
  ['train-front', 'Transport', 'train metro travel railway'],
  ['tram-front', 'Transport', 'tram local'],
  ['bike', 'Transport', 'bike bicycle cycle'],
  ['motorbike', 'Transport', 'motorbike scooter two wheeler'],
  ['plane', 'Transport', 'flight plane airline'],
  ['ship', 'Transport', 'ship ferry boat'],
  ['fuel', 'Transport', 'fuel petrol diesel gas'],
  ['square-parking', 'Transport', 'parking'],
  ['circle-gauge', 'Transport', 'service toll'],
  ['map-pin', 'Transport', 'trip location'],
  // Home & bills
  ['house', 'Home & bills', 'home rent house'],
  ['receipt', 'Home & bills', 'bills receipt invoice'],
  ['zap', 'Home & bills', 'electricity power current'],
  ['droplet', 'Home & bills', 'water'],
  ['flame', 'Home & bills', 'gas cylinder lpg'],
  ['wifi', 'Home & bills', 'internet wifi broadband'],
  ['phone', 'Home & bills', 'recharge phone bill mobile'],
  ['tv', 'Home & bills', 'tv dth cable'],
  ['sofa', 'Home & bills', 'furniture sofa'],
  ['lamp', 'Home & bills', 'lamp decor'],
  ['wrench', 'Home & bills', 'repair maintenance plumber'],
  ['hammer', 'Home & bills', 'tools hardware'],
  ['spray-can', 'Home & bills', 'cleaning'],
  ['washing-machine', 'Home & bills', 'laundry washing'],
  ['key', 'Home & bills', 'deposit keys'],
  ['building', 'Home & bills', 'society maintenance apartment'],
  // Health & fitness
  ['pill', 'Health & fitness', 'medicine pharmacy health'],
  ['stethoscope', 'Health & fitness', 'doctor clinic'],
  ['hospital', 'Health & fitness', 'hospital'],
  ['heart-pulse', 'Health & fitness', 'health checkup'],
  ['syringe', 'Health & fitness', 'vaccine injection'],
  ['dumbbell', 'Health & fitness', 'gym fitness workout'],
  ['activity', 'Health & fitness', 'sports activity'],
  ['volleyball', 'Health & fitness', 'sports game'],
  ['bike', 'Health & fitness', 'cycling'],
  ['smile', 'Health & fitness', 'dental dentist'],
  ['eye', 'Health & fitness', 'eye optician'],
  ['brain', 'Health & fitness', 'therapy mental'],
  // Entertainment
  ['clapperboard', 'Entertainment', 'movie movies cinema film'],
  ['popcorn', 'Entertainment', 'movies snacks'],
  ['ticket', 'Entertainment', 'tickets event concert'],
  ['music', 'Entertainment', 'music spotify'],
  ['gamepad-2', 'Entertainment', 'games gaming'],
  ['tv-minimal-play', 'Entertainment', 'streaming netflix subscription ott'],
  ['book', 'Entertainment', 'books reading'],
  ['party-popper', 'Entertainment', 'party celebration'],
  ['drama', 'Entertainment', 'theatre show'],
  ['palette', 'Entertainment', 'hobby art'],
  ['trophy', 'Entertainment', 'sports match'],
  // Personal care
  ['scissors', 'Personal care', 'haircut salon barber'],
  ['sparkles', 'Personal care', 'beauty spa grooming'],
  ['bath', 'Personal care', 'toiletries bath'],
  ['shower-head', 'Personal care', 'hygiene'],
  ['spray-can', 'Personal care', 'perfume'],
  // Work & education
  ['briefcase', 'Work & education', 'work office business'],
  ['graduation-cap', 'Work & education', 'education college fees course'],
  ['book-open', 'Work & education', 'study books'],
  ['pen-line', 'Work & education', 'stationery'],
  ['printer', 'Work & education', 'printing xerox'],
  ['monitor', 'Work & education', 'software'],
  ['cloud', 'Work & education', 'cloud subscription'],
  ['code', 'Work & education', 'code dev'],
  // Money
  ['wallet', 'Money', 'wallet cash'],
  ['credit-card', 'Money', 'card credit emi'],
  ['landmark', 'Money', 'bank'],
  ['piggy-bank', 'Money', 'savings'],
  ['banknote', 'Money', 'cash money'],
  ['percent', 'Money', 'tax interest'],
  ['hand-coins', 'Money', 'loan lend charity donation'],
  ['chart-line', 'Money', 'investment stocks sip'],
  ['shield', 'Money', 'insurance'],
  ['file-text', 'Money', 'fees documents'],
  // Family & pets
  ['users', 'Family & pets', 'family friends'],
  ['baby', 'Family & pets', 'baby kids child'],
  ['heart', 'Family & pets', 'love partner date'],
  ['dog', 'Family & pets', 'dog pet'],
  ['cat', 'Family & pets', 'cat pet'],
  ['paw-print', 'Family & pets', 'pets vet'],
  ['flower', 'Family & pets', 'flowers'],
  ['hand-heart', 'Family & pets', 'donation charity'],
  // Travel
  ['luggage', 'Travel', 'travel trip vacation luggage'],
  ['hotel', 'Travel', 'hotel stay'],
  ['tent', 'Travel', 'camping'],
  ['mountain', 'Travel', 'trek hiking'],
  ['tree-palm', 'Travel', 'beach holiday'],
  ['map', 'Travel', 'map tour'],
  ['globe', 'Travel', 'international visa'],
  // Misc
  ['star', 'Misc', 'star special'],
  ['circle', 'Misc', 'circle'],
  ['folder', 'Misc', 'folder'],
  ['box', 'Misc', 'box other'],
  ['ellipsis', 'Misc', 'other misc more'],
  ['church', 'Misc', 'temple religion pooja'],
  ['cigarette', 'Misc', 'smoke'],
  ['leaf', 'Misc', 'plants garden'],
]
  // de-duplicate by name, keeping the first group but merging keywords
  .reduce((acc, [name, group, kw]) => {
    const hit = acc.find(i => i.name === name);
    if (hit) hit.keywords += ' ' + kw; else acc.push({ name, group, keywords: kw });
    return acc;
  }, []);

export const ICON_NAMES = new Set(CATEGORY_ICONS.map(i => i.name));

// Icons used by the app chrome (not selectable for categories)
export const UI_ICONS = [
  'calendar-days', 'chart-column', 'tags', 'plus', 'minus', 'check', 'x', 'chevron-left', 'chevron-right',
  'pencil', 'trash-2', 'ellipsis-vertical', 'trending-up', 'trending-down', 'users', 'calendar-range',
  'calendar', 'calendar-x', 'sparkles', 'split', 'wallet', 'search', 'log-out', 'refresh-cw', 'circle-alert',
];

// Fixed palette; the Worker rejects anything else. [name, light, dark]
export const COLORS = [
  ['orange', '#ea580c', '#fb923c'],
  ['amber', '#ca8a04', '#facc15'],
  ['green', '#16a34a', '#4ade80'],
  ['teal', '#0d9488', '#2dd4bf'],
  ['blue', '#2563eb', '#60a5fa'],
  ['violet', '#9333ea', '#c084fc'],
  ['pink', '#db2777', '#f472b6'],
  ['red', '#dc2626', '#f87171'],
  ['slate', '#64748b', '#94a3b8'],
];
export const COLOR_NAMES = new Set(COLORS.map(c => c[0]));

/** Pick an icon for a new category name, e.g. "Gym" -> "dumbbell". Falls back to "tag". */
export function suggestIcon(categoryName) {
  const words = categoryName.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 1);
  if (!words.length) return 'tag';
  let best = null, bestScore = 0;
  for (const icon of CATEGORY_ICONS) {
    const kws = icon.keywords.split(' ');
    let score = 0;
    for (const w of words) {
      if (icon.name === w) score += 3;
      else if (kws.includes(w)) score += 2;
      else if (w.length >= 4 && kws.some(k => k.startsWith(w) || w.startsWith(k) && k.length >= 4)) score += 1;
    }
    if (score > bestScore) { best = icon.name; bestScore = score; }
  }
  return best ?? 'tag';
}

/** Search the picker: matches name, group or keywords. */
export function searchIcons(query) {
  const q = query.trim().toLowerCase();
  if (!q) return CATEGORY_ICONS;
  return CATEGORY_ICONS.filter(i => i.name.includes(q) || i.keywords.includes(q) || i.group.toLowerCase().includes(q));
}
