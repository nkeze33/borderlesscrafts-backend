require('dotenv').config();

const express = require('express');
const Stripe = require('stripe');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors({
  origin: [
    'https://borderlesscrafts.com',
    'https://www.borderlesscrafts.com',
    'http://localhost:3000'
  ]
}));


const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const PRODUCTS = {
  'bifold-wallet': {
    name: 'The III Bifold Wallet',
    price: 8000,
  },
  'slim-bifold-card-holder': {
    name: 'The III Slim Bifold Card Holder',
    price: 4000,
  },
  'id-card-holder': {
    name: 'The III Card Holder — ID Edition',
    price: 3000,
  },
  'black-denim-suede-bag': {
    name: 'Black Denim & Suede Bag',
    price: 5499,
  },
};

const UK_FREE_SHIPPING_THRESHOLD = 10000;
const UK_STANDARD_SHIPPING = 499;
const UK_EXPRESS_SHIPPING = 999;
const INTERNATIONAL_SHIPPING = 1499;

/*
  IMPORTANT:
  The webhook route must use express.raw() BEFORE express.json().
  Stripe requires the raw body for signature verification.
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

    if (event.type === 'checkout.session.completed') {
      try {
        const session = event.data.object;

        // Retrieve line items from Stripe
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

// Normal middleware AFTER webhook route
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.send('Borderless Crafts backend is running.');
});

app.get('/products', (req, res) => {
  res.json(PRODUCTS);
});

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, shippingRegion } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Your basket is empty.' });
    }

    if (!shippingRegion || !['GB', 'INTL'].includes(shippingRegion)) {
      return res.status(400).json({ error: `Invalid shipping region: ${shippingRegion}` });
    }

    const line_items = [];
    let subtotal = 0;

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

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: 'https://borderlesscrafts.com/success.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://borderlesscrafts.com/cancel.html',

      shipping_address_collection: {
        allowed_countries: ['GB', 'US', 'CA', 'AU', 'DE', 'FR', 'IE', 'NL'],
      },

      shipping_options,

      phone_number_collection: {
        enabled: true,
      },

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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
