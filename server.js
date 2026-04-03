require('dotenv').config();

const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');

const app = express();

/*
  Allow requests from:
  - your live site
  - your www domain
  - your local machine while testing
*/
app.use(cors({
  origin: [
    'https://borderlesscrafts.com',
    'https://www.borderlesscrafts.com',
    'http://localhost:3000'
  ]
}));

/*
  Stripe secret key comes from Render environment variables
*/
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

/*
  Product catalogue
  Prices are in pence:
  8000 = £80.00
*/
const PRODUCTS = {
  'bifold-wallet': {
    name: 'The III Bifold Wallet',
    price: 8000,
  },
  'slim-bifold-card-holder': {
    name: 'The III Slim Card Holder',
    price: 4000,
  },
  'id-card-holder': {
    name: 'The III ID Card Holder',
    price: 3000,
  },
  'black-denim-suede-bag': {
    name: 'Black Denim & Suede Bag',
    price: 5499,
  },
  'black-clip-minerva': {
    name: 'The III Clip Wallet',
    price: 11000
  },
  'vertical-kinya-lock': {
    name: 'The III Vertical Card Holder',
    price: 40.00
  }
};
/*
  Shipping settings
*/
const UK_FREE_SHIPPING_THRESHOLD = 8000; // £80
const UK_STANDARD_SHIPPING = 499; // £4.99
const UK_EXPRESS_SHIPPING = 999; // £9.99
const INTERNATIONAL_SHIPPING = 1499; // £14.99
const INTERNATIONAL_FREE_SHIPPING_THRESHOLD = 12000; // £120

/*
  Broad global list of countries allowed to checkout.
  Stripe requires country codes, so "global" means adding a wide list.
  You can remove countries later if needed.
*/
const ALLOWED_COUNTRIES = [
  'GB', 'IE', 'FR', 'DE', 'NL', 'BE', 'LU', 'ES', 'IT', 'PT', 'SE', 'NO', 'DK',
  'FI', 'AT', 'CH', 'PL', 'CZ', 'HU', 'RO', 'BG', 'HR', 'SI', 'SK', 'EE', 'LV',
  'LT', 'GR', 'CY', 'MT',
  'US', 'CA', 'MX',
  'AU', 'NZ',
  'AE', 'SA', 'QA', 'KW', 'OM', 'BH',
  'SG', 'HK', 'JP', 'KR', 'MY', 'TH',
  'ZA', 'NG', 'GH', 'KE',
  'BR'
];

/*
  IMPORTANT:
  Stripe webhook must use express.raw() BEFORE express.json().
  This is required for Stripe signature verification.
*/
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('⚠️ Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    /*
      This fires when checkout is completed successfully
    */
    if (event.type === 'checkout.session.completed') {
      try {
        const session = event.data.object;

        // Get the purchased line items from Stripe
        const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
          limit: 100,
        });

        const customerEmail =
          session.customer_details?.email || 'No email provided';
        const customerName =
          session.customer_details?.name || 'No name provided';
        const customerPhone =
          session.customer_details?.phone || 'No phone provided';

        const shippingAddress = session.shipping_details?.address
          ? [
              session.shipping_details.name || '',
              session.shipping_details.address.line1 || '',
              session.shipping_details.address.line2 || '',
              session.shipping_details.address.city || '',
              session.shipping_details.address.postal_code || '',
              session.shipping_details.address.country || '',
            ]
              .filter(Boolean)
              .join(', ')
          : 'No shipping address provided';

        const orderLines = lineItems.data.map((item) => {
          const amount = ((item.amount_total || 0) / 100).toFixed(2);
          return `- ${item.description} x ${item.quantity} (£${amount})`;
        });

        console.log('\n================ NEW ORDER ================');
        console.log(`Session ID: ${session.id}`);
        console.log(`Customer: ${customerName}`);
        console.log(`Email: ${customerEmail}`);
        console.log(`Phone: ${customerPhone}`);
        console.log(`Shipping: ${shippingAddress}`);
        console.log(`Amount paid: £${((session.amount_total || 0) / 100).toFixed(2)}`);
        console.log(`Payment status: ${session.payment_status}`);
        console.log('Items:');
        orderLines.forEach((line) => console.log(line));
        console.log('===========================================\n');
      } catch (err) {
        console.error('Error handling checkout.session.completed:', err);
      }
    }

    res.json({ received: true });
  }
);

/*
  Normal middleware
  This comes AFTER the webhook route
*/
app.use(express.json());
app.use(express.static(__dirname));

/*
  Simple root route so Render has something to show
*/
app.get('/', (req, res) => {
  res.send('Borderless Crafts backend is running.');
});

/*
  Optional products endpoint
  Useful if you want frontend to fetch product data later
*/
app.get('/products', (req, res) => {
  res.json(PRODUCTS);
});

/*
  Create Stripe Checkout session
*/
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, shippingRegion } = req.body;

    // Make sure basket exists
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Your basket is empty.' });
    }

    // Only allow UK or international as shipping modes
    if (!shippingRegion || !['GB', 'INTL'].includes(shippingRegion)) {
      return res.status(400).json({ error: `Invalid shipping region: ${shippingRegion}` });
    }

    const line_items = [];
    let subtotal = 0;

    /*
      Build Stripe line items from your product catalogue
    */
    for (const item of items) {
      const product = PRODUCTS[item.id];
      const quantity = Number(item.quantity) || 0;

      if (!product || quantity < 1) {
        return res.status(400).json({ error: 'Invalid basket item.' });
      }

      line_items.push({
        quantity,
        price_data: {
          currency: 'gbp',
          product_data: {
            name: product.name,
          },
          unit_amount: product.price,
        },
      });

      subtotal += product.price * quantity;
    }

    let shipping_options = [];

    /*
      UK shipping logic
    */
    if (shippingRegion === 'GB') {
      if (subtotal >= UK_FREE_SHIPPING_THRESHOLD) {
        shipping_options = [
          {
            shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: { amount: 0, currency: 'gbp' },
              display_name: 'Free UK shipping',
              delivery_estimate: {
                minimum: { unit: 'business_day', value: 3 },
                maximum: { unit: 'business_day', value: 5 },
              },
            },
          },
          {
            shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: { amount: UK_EXPRESS_SHIPPING, currency: 'gbp' },
              display_name: 'Express UK shipping',
              delivery_estimate: {
                minimum: { unit: 'business_day', value: 1 },
                maximum: { unit: 'business_day', value: 2 },
              },
            },
          },
        ];
      } else {
        shipping_options = [
          {
            shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: { amount: UK_STANDARD_SHIPPING, currency: 'gbp' },
              display_name: 'Standard UK shipping',
              delivery_estimate: {
                minimum: { unit: 'business_day', value: 3 },
                maximum: { unit: 'business_day', value: 5 },
              },
            },
          },
          {
            shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: { amount: UK_EXPRESS_SHIPPING, currency: 'gbp' },
              display_name: 'Express UK shipping',
              delivery_estimate: {
                minimum: { unit: 'business_day', value: 1 },
                maximum: { unit: 'business_day', value: 2 },
              },
            },
          },
        ];
      }
    } 
    
    /*
      International shipping logic
    */
    else {
      if (subtotal >= INTERNATIONAL_FREE_SHIPPING_THRESHOLD) {
        shipping_options = [
          {
            shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: { amount: 0, currency: 'gbp' },
              display_name: 'Free international shipping',
              delivery_estimate: {
                minimum: { unit: 'business_day', value: 6 },
                maximum: { unit: 'business_day', value: 12 },
              },
            },
          },
        ];
      } else {
        shipping_options = [
          {
            shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: { amount: INTERNATIONAL_SHIPPING, currency: 'gbp' },
              display_name: 'International shipping',
              delivery_estimate: {
                minimum: { unit: 'business_day', value: 6 },
                maximum: { unit: 'business_day', value: 12 },
              },
            },
          },
        ];
      }
    }

    /*
      Create Stripe Checkout session
    */
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,

      success_url: 'https://borderlesscrafts.com/success.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://borderlesscrafts.com/cancel.html',

      /*
        Stripe needs explicit allowed countries.
        This is your broad global list.
      */
      shipping_address_collection: {
        allowed_countries: ALLOWED_COUNTRIES,
      },

      shipping_options,

      /*
        Collect customer phone number
      */
      phone_number_collection: {
        enabled: true,
      },

      /*
        Metadata helps identify order info later
      */
      metadata: {
        shippingRegion,
        shopName: 'Borderless Crafts',
      },
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('Checkout session error:', error);
    res.status(500).json({ error: 'Failed to create checkout session.' });
  }
});

/*
  Render provides PORT in production
*/
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
