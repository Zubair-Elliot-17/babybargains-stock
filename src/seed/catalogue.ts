import type { Branch, Product, Supplier } from "@/domain/schemas";

// Fictional chain and catalogue. Variants are separate SKUs grouped by parentSku.

export const BRANCHES: Branch[] = [
  ["LEE", "Leeds Kirkgate", "North"],
  ["MAN", "Manchester Arndale", "North West"],
  ["BRS", "Bristol Cabot", "South West"],
  ["GLA", "Glasgow Buchanan", "Scotland"],
  ["BHM", "Birmingham Bullring", "Midlands"],
  ["LIV", "Liverpool One", "North West"],
  ["NCL", "Newcastle Eldon", "North East"],
  ["SHF", "Sheffield Meadowhall", "Yorkshire"],
  ["CDF", "Cardiff St David's", "Wales"],
  ["NOT", "Nottingham Victoria", "Midlands"],
  ["EDI", "Edinburgh Princes St", "Scotland"],
  ["LDN", "London Stratford", "London"],
  ["SOU", "Southampton WestQuay", "South"],
  ["NWH", "Norwich Chapelfield", "East"],
  ["BEL", "Belfast Victoria Sq", "Northern Ireland"],
].map(([code, name, region]) => ({ _id: `BR-${code}`, code, name, region }));

export const SUPPLIERS: Supplier[] = [
  { _id: "SUP-OAK", name: "Little Oak Ltd", adapter: "little-oak-v1" },
  { _id: "SUP-ROAM", name: "Roam Prams", adapter: "roam-v2" },
  { _id: "SUP-SAFE", name: "SafeSound Electronics", adapter: "safesound-v1" },
  { _id: "SUP-SNUG", name: "Snuggle Textiles", adapter: "snuggle-csvjson" },
  { _id: "SUP-WOND", name: "Wonder Toys Co", adapter: "wonder-v1" },
];

const COTS = ["Dreamtime Cot 120", "Hush Sleigh Cot", "Nest Cot Bed 140", "Willow Cot", "Haven Convertible Cot", "Cloud Mini Cot", "Harbour Cot 120", "Fern Drop-side Cot", "Juniper Cot Bed", "Maple Travel Cot"];
const PRAMS = ["Roam City Pram", "Roam Trail 3-in-1", "Glide Compact Stroller", "Breeze Pushchair", "Voyager Twin", "Pebble Lite Stroller", "Orbit Travel System", "Summit All-terrain"];
const MONITORS = ["SafeSound Audio 300", "SafeSound Video 5", "SafeSound Video 7 Pro", "Lullaby Audio Lite", "NightOwl Video 4.3", "NightOwl Breathing Pad", "Echo Duo Audio", "Echo Video HD", "Guardian Wi-Fi Cam", "Guardian Split-screen"];
const CLOTHES = ["Organic Babygrow", "Ribbed Romper", "Sleepsuit 2-pack", "Cardigan Knit", "Muslin Bodysuit", "Dungarees", "Fleece Pramsuit", "Bib 3-pack", "Snowsuit", "Hooded Towel", "Leggings 2-pack", "Swaddle Sack", "Long-sleeve Vest", "Cord Trousers", "Sun Hat", "Mittens Set", "Bamboo Pyjamas", "Puffer Jacket", "Booties", "Jersey Dress", "Shortie Romper", "Wrap Top", "Joggers", "Sleeping Bag 2.5 tog"];
const TOY_KINDS = ["Stacking Rings", "Activity Gym", "Soft Rattle", "Teether", "Shape Sorter", "Bath Ducks", "Musical Mobile", "Wooden Blocks", "Push Walker", "Board Book", "Plush Bunny", "Sensory Ball"];
const TOY_LINES = ["Pebble", "Wonder", "Tiny", "Meadow", "Coral", "Sunny", "Breeze", "Acorn", "Moss", "Pip"];

const sizes = ["0-3m", "3-6m", "6-12m"];
const colours = ["Oat", "Sage"];

function slug(s: string) {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 16);
}

export function buildCatalogue(skuTarget: number): Product[] {
  const out: Product[] = [];
  const seen = new Set<string>();
  const add = (p: Product) => {
    if (seen.has(p._id)) throw new Error(`Duplicate SKU ${p._id}`);
    seen.add(p._id);
    if (out.length < skuTarget) out.push(p);
  };
  COTS.forEach((name, i) => {
    const parentSku = `COT-${slug(name)}`;
    for (const finish of ["Oak", "White"]) {
      add({
        _id: `${parentSku}-${finish.toUpperCase()}`, parentSku, name: `${name} · ${finish}`, supplierId: "SUP-OAK",
        price: 14999 + i * 2000, batchTracked: true, category: "cot",
        attributes: { widthCm: 64, lengthCm: name.includes("140") ? 146 : 126, finish, safetyStandard: "BS EN 716-1:2017" },
      });
    }
  });
  PRAMS.forEach((name, i) => {
    const parentSku = `PRAM-${slug(name)}`;
    for (const c of ["Graphite", "Sand"]) {
      add({
        _id: `${parentSku}-${c.toUpperCase()}`, parentSku, name: `${name} · ${c}`, supplierId: "SUP-ROAM",
        price: 19999 + i * 4000, batchTracked: true, category: "pram",
        attributes: { weightKg: 7 + (i % 5), foldable: true, safetyStandard: "BS EN 1888-1:2018" },
      });
    }
  });
  MONITORS.forEach((name, i) => {
    const parentSku = `MON-${slug(name)}`;
    add({
      _id: parentSku, parentSku, name, supplierId: "SUP-SAFE", price: 3999 + i * 1500, batchTracked: true,
      category: "monitor", attributes: { rangeM: 250 + i * 25, video: /Video|Cam|screen/.test(name), warrantyMonths: 24 },
    });
  });
  CLOTHES.forEach((name, i) => {
    const parentSku = `CLO-${slug(name)}`;
    for (const size of sizes) for (const colour of colours) {
      add({
        _id: `${parentSku}-${size.replace(/[^0-9]/g, "")}-${colour.toUpperCase()}`, parentSku,
        name: `${name} · ${size} · ${colour}`, supplierId: "SUP-SNUG", price: 699 + (i % 8) * 300,
        batchTracked: false, category: "clothing", attributes: { size, colour, material: i % 3 ? "Organic cotton" : "Bamboo" },
      });
    }
  });
  let t = 0;
  while (out.length < skuTarget) {
    const name = `${TOY_LINES[t % TOY_LINES.length]} ${TOY_KINDS[Math.floor(t / TOY_LINES.length) % TOY_KINDS.length]}`;
    const sku = `TOY-${slug(name)}-${t}`;
    add({
      _id: sku, parentSku: sku, name, supplierId: "SUP-WOND", price: 599 + (t % 10) * 250, batchTracked: false,
      category: "toy", attributes: { ageMonthsMin: (t % 4) * 3, material: t % 2 ? "Wood" : "Recycled plastic" },
    });
    t++;
  }
  return out;
}
