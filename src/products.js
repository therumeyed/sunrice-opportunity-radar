// SunRice's real, current product range -- 66 products, confirmed directly
// from the user viewing the rendered "Showing 66 Products" page at
// https://www.sunrice.com.au/products (a JS-rendered Nuxt site that
// couldn't be scraped automatically -- the client pasted the actual
// rendered product grid, and the count was verified against the page's own
// header). Used only to ground the LLM strategist's product-fit reasoning
// in src/llmStrategist.js -- it must never suggest a product that isn't in
// this list, and this list must never be invented.
//
// No price data available from the rendered product grid -- never
// fabricated; `sizes` (real pack sizes from the same page) is included
// instead where given.
const PRODUCTS = [
  { name: 'SunRice Indian Basmati Rice', sizes: '1kg, 5kg' },
  { name: 'SunRice Microwave Coconut Rice Cups', sizes: '125g cup' },
  { name: 'SunRice Microwave Garlic Butter & Herb Flavoured Rice Cups', sizes: '125g cup' },
  { name: 'SunRice Microwave Japanese Teriyaki Style Rice Cups', sizes: '125g cup' },
  { name: 'SunRice Premium Thai Hom Mali Jasmine Rice', sizes: '1kg, 5kg' },
  { name: 'SunRice Microwave Chicken Style Rice Cups', sizes: '125g cup' },
  { name: 'SunRice Microwave Mexican Style Rice Cups', sizes: '125g cup' },
  { name: 'SunRice Microwave Special Fried Rice Cups', sizes: '125g cup' },
  { name: 'Original Thick Rice Cakes', sizes: '160g' },
  { name: 'Original Thin Rice Cakes', sizes: '150g' },
  { name: 'Salt & Balsamic Vinegar Rice Cakes', sizes: '160g' },
  { name: 'Sour Cream & Chives Rice Cakes', sizes: '160g' },
  { name: 'Sundried Tomato & Basil Rice Cakes', sizes: '160g' },
  { name: 'SunRice Jasmine Fragrant Rice (5kg)', sizes: '5kg' },
  { name: 'SunRice Premium Thai Jasmine Rice (20kg)', sizes: '20kg' },
  { name: 'SunRice Jasmine Fragrant Rice', sizes: '1kg, 2kg' },
  { name: 'SunRice Rice & Quinoa', sizes: '750g' },
  { name: 'Sunlong Long Grain Rice', sizes: '10kg, 20kg' },
  { name: 'Sunwhite Medium Grain Rice', sizes: '10kg' },
  { name: 'Sunbrown Medium Grain Brown Rice', sizes: '20kg' },
  { name: 'SunRice Cambodian Jasmine Rice', sizes: '20kg' },
  { name: 'SunRice Short Grain Rice', sizes: '5kg, 10kg, 20kg' },
  { name: 'SunRice Koshihikari (bulk)', sizes: '5kg, 10kg, 20kg' },
  { name: 'SunRice Calrose Medium Grain Rice', sizes: '20kg' },
  { name: 'SunRice Premium Topaz Jasmine Rice', sizes: '10kg, 20kg' },
  { name: 'SunRice Doongara Low GI White Rice' },
  { name: 'SunRice Indian Classic Basmati Rice', sizes: '5kg' },
  { name: 'Kokusai Rice', sizes: '20kg' },
  { name: 'Riviana One Pan Risotto Italian Style', sizes: '240g' },
  { name: 'Riviana One Pan Risotto Mediterranean Style', sizes: '240g' },
  { name: 'SunRice Brown Medium Grain Rice', sizes: '1kg, 2kg, 5kg' },
  { name: 'Mini Bites Salt & Vinegar', sizes: '120g (6x20g)' },
  { name: 'Mini Bites Sea Salt', sizes: '108g (6x18g)' },
  { name: 'Mini Bites Chicken', sizes: '120g (6x20g)' },
  { name: 'Mini Bites Cheese', sizes: '120g (6x20g)' },
  { name: 'SunRice Koshihikari Rice', sizes: '750g' },
  { name: 'Protein Chips Barbeque flavour', sizes: '50g' },
  { name: 'Protein Chips Honey Soy flavour', sizes: '50g' },
  { name: 'Protein Chips Sour Cream & Chives flavour', sizes: '50g' },
  { name: 'Riviana Arborio Rice', sizes: '1kg' },
  { name: 'Riviana Basmati & Long Grain Blend', sizes: '5kg' },
  { name: 'Riviana Basmati Rice Extra Long Grain', sizes: '1kg, 2kg' },
  { name: 'Riviana Brown Basmati Rice Extra Long Grain', sizes: '1kg' },
  { name: 'SunRice Basmati Rice', sizes: '1kg, 2kg' },
  { name: 'SunRice Hinata Short Grain Rice', sizes: '5kg, 20kg' },
  { name: 'SunRice Long Grain White Rice', sizes: '1kg, 2kg' },
  { name: 'SunRice Low GI Brown Rice', sizes: '1kg' },
  { name: 'SunRice Low GI White Rice', sizes: '1kg' },
  { name: 'SunRice Microwave Basmati Rice Cups', sizes: '125g cup' },
  { name: 'SunRice Microwave Basmati Rice Pouch', sizes: '250g, 450g' },
  { name: 'SunRice Microwave Black Rice Pouch', sizes: '250g' },
  { name: 'SunRice Microwave Brown Rice Cups', sizes: '125g cup' },
  { name: 'SunRice Microwave Brown Rice Pouch', sizes: '250g, 450g' },
  { name: 'SunRice Microwave Brown Rice & Quinoa Cups', sizes: '125g cup' },
  { name: 'SunRice Microwave Brown Rice & Quinoa Pouch', sizes: '250g, 450g' },
  { name: 'SunRice Microwave Jasmine Rice Cups', sizes: '125g cup' },
  { name: 'SunRice Microwave Jasmine Rice Pouch', sizes: '250g, 450g' },
  { name: 'SunRice Microwave Long Grain White Rice Pouch', sizes: '250g, 450g' },
  { name: 'SunRice Microwave Medium Grain Pouch', sizes: '250g' },
  { name: 'SunRice Microwave Organic Brown Rice Pouch', sizes: '250g' },
  { name: 'SunRice Microwave White Long Grain Rice Cups', sizes: '125g cup' },
  { name: 'SunRice Risotto Style Rice', sizes: '750g' },
  { name: 'SunRice Sushi Rice', sizes: '1kg' },
  { name: 'SunRice White Medium Grain Rice', sizes: '1kg, 2kg, 5kg' },
  { name: 'Protein+ Rice', sizes: '125g pouch, 125g cup' },
  { name: 'Mini Bites Cinnamon Churro', sizes: '120g (6x20g)' }
];

module.exports = { PRODUCTS };
