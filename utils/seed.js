const mongoose = require("mongoose");
require("dotenv").config();

// NOTE: ensure your model export matches this path & name:
// module.exports = mongoose.model("Product", productSchema);
const Product = require("../models/product");

// --- DB Connect ---
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://localhost:27017/ets-dieu-merci";

async function connectDB() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected to MongoDB for seeding");
  } catch (error) {
    console.error("❌ Error connecting to MongoDB:", error);
    process.exit(1);
  }
}

// --- Seed Data (matches Product schema) ---
const products = [
  {
    name: "Leather Handbag",
    description: "Classic leather handbag with interior zip pocket.",
    category: "Handbags",
    brand: "UrbanGear",
    stock: 20,
    minStock: 5,
    unit: "pcs",
    weight: 0.9, // kg
    status: "active",
  },
  {
    name: "Travel Backpack",
    description: "Durable backpack with padded laptop sleeve (15”).",
    category: "Backpacks",
    brand: "TrailMate",
    stock: 35,
    minStock: 6,
    unit: "pcs",
    weight: 1.1,
    status: "active",
  },
  {
    name: "Laptop Messenger Bag",
    description: "Water-resistant messenger bag for 13–15” laptops.",
    category: "Messenger Bags",
    brand: "WorkCarry",
    stock: 15,
    minStock: 4,
    unit: "pcs",
    weight: 0.85,
    status: "active",
  },
  {
    name: "Canvas Tote Bag",
    description: "Eco-friendly canvas tote with inner pocket.",
    category: "Totes",
    brand: "EcoCarry",
    stock: 40,
    minStock: 8,
    unit: "pcs",
    weight: 0.4,
    status: "active",
  },
  {
    name: "Rolling Suitcase (Medium)",
    description: "Hard-shell 24” suitcase with 360° spinner wheels.",
    category: "Suitcases",
    brand: "JetSet",
    stock: 10,
    minStock: 2,
    unit: "pcs",
    weight: 3.8,
    status: "active",
  },
  {
    name: "Rolling Suitcase (Large)",
    description: "Hard-shell 28” suitcase with TSA lock.",
    category: "Suitcases",
    brand: "JetSet",
    stock: 8,
    minStock: 2,
    unit: "pcs",
    weight: 4.6,
    status: "active",
  },
  {
    name: "Crossbody Sling Bag",
    description: "Compact sling bag with anti-theft zipper.",
    category: "Crossbody",
    brand: "StreetLite",
    stock: 25,
    minStock: 5,
    unit: "pcs",
    weight: 0.5,
    status: "active",
  },
  {
    name: "Duffel Gym Bag",
    description: "Spacious gym duffel with ventilated shoe pocket.",
    category: "Duffel",
    brand: "FitCarry",
    stock: 18,
    minStock: 4,
    unit: "pcs",
    weight: 1.2,
    status: "active",
  },
  {
    name: "Mini Backpack (Kids)",
    description: "Lightweight mini backpack for kids, fun prints.",
    category: "Kids",
    brand: "KidGo",
    stock: 30,
    minStock: 6,
    unit: "pcs",
    weight: 0.35,
    status: "active",
  },
  {
    name: "Luxury Clutch Purse",
    description: "Evening clutch with metallic clasp and chain strap.",
    category: "Clutches",
    brand: "Elegance",
    stock: 12,
    minStock: 3,
    unit: "pcs",
    weight: 0.25,
    status: "active",
  },
];

// --- Seed Runner ---
async function seed() {
  await connectDB();

  try {
    // Optional: clear existing products before seeding
    // await Product.deleteMany({});

    const result = await Product.insertMany(products, { ordered: false });
    console.log(`✅ Seeded ${result.length} products`);
  } catch (error) {
    console.error("❌ Error seeding products:", error?.message || error);
  } finally {
    await mongoose.connection.close();
    console.log("🔌 MongoDB connection closed");
  }
}

seed();
