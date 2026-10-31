// Creates the static-OTP (1234) test accounts from utils/otp.js. Safe to re-run.
// Usage: node scripts/seedTestAccounts.js
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Customer from '../app/models/customer.js';
import Delivery from '../app/models/delivery.js';

dotenv.config();

async function seed() {
    await mongoose.connect(process.env.MONGO_URI);

    // Customer phones are stored as +91XXXXXXXXXX (normalised in a pre-save hook).
    let customer = await Customer.findOne({ phone: '+917878787878' });
    if (!customer) {
        customer = await Customer.create({ name: 'Test Customer', phone: '7878787878', isVerified: true });
        console.log('Created customer', customer.phone);
    } else {
        console.log('Customer already exists', customer.phone);
    }

    // Rider phones are stored as the bare 10 digits the app sends.
    let rider = await Delivery.findOne({ phone: '8787878787' });
    if (!rider) {
        rider = await Delivery.create({
            name: 'Test Driver',
            phone: '8787878787',
            applicationStatus: 'approved',
            isVerified: true,
            isActive: true,
        });
        console.log('Created driver', rider.phone);
    } else {
        console.log('Driver already exists', rider.phone, rider.applicationStatus);
    }

    await mongoose.disconnect();
}

seed().catch((err) => {
    console.error('Seeding failed:', err);
    process.exit(1);
});
