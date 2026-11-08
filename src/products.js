// SunRice's real, current product range. The flat `name`/`sizes` shape
// (66 products) was the original v1 catalogue -- confirmed directly from
// the user viewing the rendered "Showing 66 Products" page, pasted by
// hand because the live site's product LISTING grid is client-side
// rendered (Nuxt) and never returns real content to a plain fetch.
//
// Enriched 2026-11-08 (Stage 2 of IMPLEMENTATION_CHECKLIST.md): unlike
// the listing grid, each product's own DETAIL page at
// sunrice.com.au/products/<slug> DOES render real content to a plain
// fetch -- discovered via the site's sitemap.xml, which lists ~63 real
// product-detail URLs. Two confidence levels, never blurred together:
//   - `verified: true` -- the product's own detail page was actually
//     fetched on 2026-11-08 and its `uses`/`category`/`sizes` come
//     straight from that page's real text.
//   - `verified: false` -- `url` is a best-effort match against the real
//     slug list by product name/size correspondence (not clicked
//     through), and `category` is assigned by matching the product name
//     against the site's own real top-level categories (Everyday Rice /
//     Healthy Rice Blends / Microwave Rice / Rice Snacks / Professional
//     -- confirmed from the site's own footer nav), not fetched per
//     product. `uses` is `null` here -- NEVER inferred or guessed; an
//     unverified product's real described uses are simply not yet known
//     to this system, and showing a guess as if it were a site claim
//     would be exactly the fabrication the brief warns against.
// A `url: null` means no confident slug match was found (genuine
// ambiguity between near-identical SKUs, e.g. several "Indian Basmati"
// variants) -- flagged for a human to resolve, never guessed.
//
// Still no price data -- never fabricated.
const PRODUCTS = [
  { name: 'SunRice Indian Basmati Rice', sizes: '1kg, 5kg', category: 'Everyday Rice', url: 'https://www.sunrice.com.au/products/sunrice-premium-indian-basmati-rice', verified: false, uses: null, note: 'Catalogue name omits "Premium" -- real page title may differ, worth a human check' },
  { name: 'SunRice Microwave Coconut Rice Cups', sizes: '125g cup', category: 'Microwave Rice', url: 'https://www.sunrice.com.au/products/sunrice-coconut-rice-cups', verified: false, uses: null },
  { name: 'SunRice Microwave Garlic Butter & Herb Flavoured Rice Cups', sizes: '125g cup', category: 'Microwave Rice', url: 'https://www.sunrice.com.au/products/sunrice-garlicbutter-and-herb-rice-cups', verified: false, uses: null },
  { name: 'SunRice Microwave Japanese Teriyaki Style Rice Cups', sizes: '125g cup', category: 'Microwave Rice', url: 'https://www.sunrice.com.au/products/sunrice-teriyaki-rice-cups', verified: false, uses: null },
  { name: 'SunRice Premium Thai Hom Mali Jasmine Rice', sizes: '1kg, 5kg', category: 'Everyday Rice', url: 'https://www.sunrice.com.au/products/sunrice-premium-thai-jasmine-rice', verified: false, uses: null },
  { name: 'SunRice Microwave Chicken Style Rice Cups', sizes: '125g cup', category: 'Microwave Rice', url: 'https://www.sunrice.com.au/products/sunrice-quick-cups-chicken-style', verified: false, uses: null },
  { name: 'SunRice Microwave Mexican Style Rice Cups', sizes: '125g cup', category: 'Microwave Rice', url: 'https://www.sunrice.com.au/products/sunrice-quick-cups-mexican-style', verified: false, uses: null },
  {
    name: 'SunRice Microwave Special Fried Rice Cups', sizes: '125g cup', category: 'Microwave Rice',
    url: 'https://www.sunrice.com.au/products/sunrice-quick-cups-special-fried-rice', verified: true, verifiedAt: '2026-11-08',
    uses: ['Perfect base for Asian meals', 'Stir-fries and fried rice', 'Pairs with any protein (ham, chicken)', 'Single-serve lunch or snack']
  },
  { name: 'Original Thick Rice Cakes', sizes: '160g', category: 'Rice Snacks', url: 'https://www.sunrice.com.au/products/original-thick-rice-cakes', verified: true, verifiedAt: '2026-11-08', uses: ['Snacking between meals', 'Plain or with toppings', 'Bread replacement'] },
  { name: 'Original Thin Rice Cakes', sizes: '150g', category: 'Rice Snacks', url: 'https://www.sunrice.com.au/products/original-thin-rice-cakes', verified: false, uses: null },
  { name: 'Salt & Balsamic Vinegar Rice Cakes', sizes: '160g', category: 'Rice Snacks', url: 'https://www.sunrice.com.au/products/salt-balsamic-vinegar-flavoured-thin-rice-cakes', verified: false, uses: null },
  { name: 'Sour Cream & Chives Rice Cakes', sizes: '160g', category: 'Rice Snacks', url: 'https://www.sunrice.com.au/products/sour-cream-chives-rice-cakes', verified: false, uses: null },
  { name: 'Sundried Tomato & Basil Rice Cakes', sizes: '160g', category: 'Rice Snacks', url: 'https://www.sunrice.com.au/products/sundried-tomato-and-basil-rice-cakes', verified: false, uses: null },
  { name: 'SunRice Jasmine Fragrant Rice (5kg)', sizes: '5kg', category: 'Everyday Rice', url: 'https://www.sunrice.com.au/products/sunrise-jasmine-fragrant-rice-5kg', verified: false, uses: null, note: 'Real site URL itself has a typo ("sunrise" not "sunrice") -- kept as-is since that is the real, working URL' },
  { name: 'SunRice Premium Thai Jasmine Rice (20kg)', sizes: '20kg', category: 'Professional', url: 'https://www.sunrice.com.au/products/sunrice-premium-thai-jasmine-rice-20kg', verified: false, uses: null },
  {
    name: 'SunRice Jasmine Fragrant Rice', sizes: '1kg, 2kg', category: 'Everyday Rice',
    url: 'https://www.sunrice.com.au/products/jasmine-fragrant', verified: true, verifiedAt: '2026-11-08',
    uses: ['Stir fries and curries', 'Fried rice', 'Chinese meals', 'Thai cuisine']
  },
  {
    name: 'SunRice Rice & Quinoa', sizes: '750g', category: 'Healthy Rice Blends',
    url: 'https://www.sunrice.com.au/products/rice-quinoa', verified: true, verifiedAt: '2026-11-08',
    uses: ['Salads and pilafs', 'Base for grilled fish', 'Curries, stir-fries, fried rice', 'Poke bowls']
  },
  { name: 'Sunlong Long Grain Rice', sizes: '10kg, 20kg', category: 'Professional', url: 'https://www.sunrice.com.au/products/sunlong-long-grain-rice-2', verified: false, uses: null },
  {
    name: 'Sunwhite Medium Grain Rice', sizes: '10kg', category: 'Everyday Rice',
    url: 'https://www.sunrice.com.au/products/calrose-medium-grain-rice', verified: true, verifiedAt: '2026-11-08',
    uses: ['Creamy dishes like paella', 'Middle Eastern, Korean, Spanish cuisines', 'Desserts', 'Fried rice, risotto, side dishes, salads']
  },
  { name: 'Sunbrown Medium Grain Brown Rice', sizes: '20kg', category: 'Professional', url: 'https://www.sunrice.com.au/products/sunbrown-calrose-rice', verified: false, uses: null },
  { name: 'SunRice Cambodian Jasmine Rice', sizes: '20kg', category: 'Professional', url: 'https://www.sunrice.com.au/products/sunrice-cambodian-jasmine-rice', verified: false, uses: null },
  { name: 'SunRice Short Grain Rice', sizes: '5kg, 10kg, 20kg', category: 'Professional', url: 'https://www.sunrice.com.au/products/sunrice-short-grain-rice', verified: false, uses: null },
  { name: 'SunRice Koshihikari (bulk)', sizes: '5kg, 10kg, 20kg', category: 'Professional', url: 'https://www.sunrice.com.au/products/sunrice-koshihikari', verified: false, uses: null },
  { name: 'SunRice Calrose Medium Grain Rice', sizes: '20kg', category: 'Professional', url: 'https://www.sunrice.com.au/products/sunrice-calrose-medium-grain-rice', verified: false, uses: null },
  { name: 'SunRice Premium Topaz Jasmine Rice', sizes: '10kg, 20kg', category: 'Professional', url: 'https://www.sunrice.com.au/products/sunrice-premium-topaz-jasmine-rice', verified: false, uses: null },
  { name: 'SunRice Doongara Low GI White Rice', sizes: null, category: 'Healthy Rice Blends', url: 'https://www.sunrice.com.au/products/sunwhite-doongara-low-gi-white-rice', verified: false, uses: null, note: 'May be the same real product as "SunRice Low GI White Rice" below under a different brand name -- worth a human check for a catalogue duplicate' },
  {
    name: 'SunRice Indian Classic Basmati Rice', sizes: '5kg', category: 'Everyday Rice',
    url: 'https://www.sunrice.com.au/products/sunrice-classic-indian-basmati-rice', verified: true, verifiedAt: '2026-11-08',
    uses: ['Bed for curry', 'Curry and Indian meals'], note: 'Real page title is "SunRice Classic Indian Basmati Rice" (word order) and also lists a 1kg size alongside 5kg'
  },
  { name: 'Kokusai Rice', sizes: '20kg', category: 'Professional', url: 'https://www.sunrice.com.au/products/kokusai-rice', verified: false, uses: null },
  { name: 'Riviana One Pan Risotto Italian Style', sizes: '240g', category: 'Everyday Rice', url: 'https://www.sunrice.com.au/products/riviana-one-pan-risotto-italian-style', verified: false, uses: null },
  {
    name: 'Riviana One Pan Risotto Mediterranean Style', sizes: '240g', category: 'Everyday Rice',
    url: 'https://www.sunrice.com.au/products/riviana-one-pan-risotto-mediterranean-style', verified: true, verifiedAt: '2026-11-08',
    uses: ['Risotto and paella']
  },
  { name: 'SunRice Brown Medium Grain Rice', sizes: '1kg, 2kg, 5kg', category: 'Everyday Rice', url: null, verified: false, uses: null, note: 'No confident slug match found -- several brown-rice pages exist (brown-medium-grain, steamed-brown-rice) but none clearly match this exact size range' },
  { name: 'Mini Bites Salt & Vinegar', sizes: '120g (6x20g)', category: 'Rice Snacks', url: 'https://www.sunrice.com.au/products/mini-bites-salt-vinegar', verified: false, uses: null },
  { name: 'Mini Bites Sea Salt', sizes: '108g (6x18g)', category: 'Rice Snacks', url: 'https://www.sunrice.com.au/products/mini-bites-seasalt', verified: false, uses: null },
  { name: 'Mini Bites Chicken', sizes: '120g (6x20g)', category: 'Rice Snacks', url: 'https://www.sunrice.com.au/products/mini-bites-chicken', verified: false, uses: null },
  { name: 'Mini Bites Cheese', sizes: '120g (6x20g)', category: 'Rice Snacks', url: 'https://www.sunrice.com.au/products/mini-bites-cheese', verified: false, uses: null },
  {
    name: 'SunRice Koshihikari Rice', sizes: '750g', category: 'Everyday Rice',
    url: 'https://www.sunrice.com.au/products/koshihikari', verified: true, verifiedAt: '2026-11-08',
    uses: ['Sushi, poke bowls, Japanese meals', 'Japanese, Korean, Chinese cuisines', 'Desserts']
  },
  { name: 'Protein Chips Barbeque flavour', sizes: '50g', category: 'Rice Snacks', url: 'https://www.sunrice.com.au/products/protein-chips-barbeque-flavour', verified: false, uses: null },
  { name: 'Protein Chips Honey Soy flavour', sizes: '50g', category: 'Rice Snacks', url: 'https://www.sunrice.com.au/products/protein-chips-honey-soy-flavour', verified: false, uses: null },
  { name: 'Protein Chips Sour Cream & Chives flavour', sizes: '50g', category: 'Rice Snacks', url: 'https://www.sunrice.com.au/products/protein-chips-sour-cream-chives-flavour', verified: false, uses: null },
  { name: 'Riviana Arborio Rice', sizes: '1kg', category: 'Everyday Rice', url: 'https://www.sunrice.com.au/products/riviana-arborio-rice', verified: false, uses: null },
  { name: 'Riviana Basmati & Long Grain Blend', sizes: '5kg', category: 'Everyday Rice', url: 'https://www.sunrice.com.au/products/riviana-basmati-long-grain-rice-blend', verified: false, uses: null },
  { name: 'Riviana Basmati Rice Extra Long Grain', sizes: '1kg, 2kg', category: 'Everyday Rice', url: 'https://www.sunrice.com.au/products/riviana-basmati-rice-extra-long-grain', verified: false, uses: null },
  { name: 'Riviana Brown Basmati Rice Extra Long Grain', sizes: '1kg', category: 'Healthy Rice Blends', url: 'https://www.sunrice.com.au/products/riviana-brown-basmati-rice-extra-long-grain', verified: false, uses: null },
  { name: 'SunRice Basmati Rice', sizes: '1kg, 2kg', category: 'Everyday Rice', url: 'https://www.sunrice.com.au/products/sunrice-basmati-rice', verified: false, uses: null },
  { name: 'SunRice Hinata Short Grain Rice', sizes: '5kg, 20kg', category: 'Everyday Rice', url: 'https://www.sunrice.com.au/products/sunrice-hinata-short-grain-rice', verified: false, uses: null },
  { name: 'SunRice Long Grain White Rice', sizes: '1kg, 2kg', category: 'Everyday Rice', url: 'https://www.sunrice.com.au/products/white-long-grain', verified: false, uses: null },
  { name: 'SunRice Low GI Brown Rice', sizes: '1kg', category: 'Healthy Rice Blends', url: 'https://www.sunrice.com.au/products/naturally-low-gi-brown', verified: false, uses: null },
  {
    name: 'SunRice Low GI White Rice', sizes: '1kg', category: 'Healthy Rice Blends',
    url: 'https://www.sunrice.com.au/products/naturally-low-gi-white-rice', verified: true, verifiedAt: '2026-11-08',
    uses: ['Substitute for other rice varieties', 'Fried rice and stir-fry'], note: 'Doongara variety, naturally low GI'
  },
  { name: 'SunRice Microwave Basmati Rice Cups', sizes: '125g cup', category: 'Microwave Rice', url: 'https://www.sunrice.com.au/products/quick-cups-basmati-rice', verified: false, uses: null },
  { name: 'SunRice Microwave Basmati Rice Pouch', sizes: '250g, 450g', category: 'Microwave Rice', url: 'https://www.sunrice.com.au/products/steamed-basmati-rice', verified: false, uses: null },
  { name: 'SunRice Microwave Black Rice Pouch', sizes: '250g', category: 'Microwave Rice', url: 'https://www.sunrice.com.au/products/sunrice-steamed-black-rice-250g', verified: false, uses: null },
  { name: 'SunRice Microwave Brown Rice Cups', sizes: '125g cup', category: 'Microwave Rice', url: 'https://www.sunrice.com.au/products/quick-cups-brown-rice', verified: false, uses: null },
  { name: 'SunRice Microwave Brown Rice Pouch', sizes: '250g, 450g', category: 'Microwave Rice', url: 'https://www.sunrice.com.au/products/steamed-brown-rice', verified: false, uses: null },
  { name: 'SunRice Microwave Brown Rice & Quinoa Cups', sizes: '125g cup', category: 'Microwave Rice', url: 'https://www.sunrice.com.au/products/quick-cups-brown-rice-quinoa', verified: false, uses: null },
  { name: 'SunRice Microwave Brown Rice & Quinoa Pouch', sizes: '250g, 450g', category: 'Microwave Rice', url: 'https://www.sunrice.com.au/products/steamed-brown-rice-quinoa', verified: false, uses: null },
  { name: 'SunRice Microwave Jasmine Rice Cups', sizes: '125g cup', category: 'Microwave Rice', url: 'https://www.sunrice.com.au/products/quick-cups-fragrant-jasmine-rice', verified: false, uses: null },
  { name: 'SunRice Microwave Jasmine Rice Pouch', sizes: '250g, 450g', category: 'Microwave Rice', url: 'https://www.sunrice.com.au/products/steamed-jasmine-rice', verified: false, uses: null },
  { name: 'SunRice Microwave Long Grain White Rice Pouch', sizes: '250g, 450g', category: 'Microwave Rice', url: 'https://www.sunrice.com.au/products/sunrice-steamed-long-grain-white-rice', verified: false, uses: null },
  { name: 'SunRice Microwave Medium Grain Pouch', sizes: '250g', category: 'Microwave Rice', url: 'https://www.sunrice.com.au/products/steamed-medium-grain-rice', verified: false, uses: null },
  { name: 'SunRice Microwave Organic Brown Rice Pouch', sizes: '250g', category: 'Microwave Rice', url: 'https://www.sunrice.com.au/products/steamed-organic-brown-rice', verified: false, uses: null },
  { name: 'SunRice Microwave White Long Grain Rice Cups', sizes: '125g cup', category: 'Microwave Rice', url: 'https://www.sunrice.com.au/products/quick-cups-white-long-grain-rice', verified: false, uses: null },
  { name: 'SunRice Risotto Style Rice', sizes: '750g', category: 'Everyday Rice', url: 'https://www.sunrice.com.au/products/risotto-style-rice', verified: false, uses: null },
  {
    name: 'SunRice Sushi Rice', sizes: '1kg', category: 'Everyday Rice',
    url: 'https://www.sunrice.com.au/products/japanese-style-sushi', verified: true, verifiedAt: '2026-11-08',
    uses: ['Sushi', 'Poke bowls', 'Japanese meals', 'Sushi rolls for light lunches, snacks, party platters']
  },
  { name: 'SunRice White Medium Grain Rice', sizes: '1kg, 2kg, 5kg', category: 'Everyday Rice', url: 'https://www.sunrice.com.au/products/white-medium-grain', verified: false, uses: null },
  { name: 'Protein+ Rice', sizes: '125g pouch, 125g cup', category: 'Healthy Rice Blends', url: 'https://www.sunrice.com.au/products/protein-rice', verified: false, uses: null },
  { name: 'Mini Bites Cinnamon Churro', sizes: '120g (6x20g)', category: 'Rice Snacks', url: 'https://www.sunrice.com.au/products/mini-bites-cinnamon-churro', verified: false, uses: null }
];

// Real categories as they actually exist on the site's own nav (footer of
// sunrice.com.au/products), confirmed 2026-11-08 -- never invented. Every
// `category` value above must be one of these.
const CATEGORIES = ['Everyday Rice', 'Healthy Rice Blends', 'Microwave Rice', 'Rice Snacks', 'Professional'];

module.exports = { PRODUCTS, CATEGORIES };
