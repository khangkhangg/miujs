/**
 * bun run seed [email]  ->  a published "Sample house" tour owned by `email` (default demo@example.com).
 * The user is created when missing; its password is printed once.
 */
import { createUser, findUser, openData, randomToken } from "../src/data.ts";
import { seedSampleTour } from "../src/sample.ts";

const data = await openData(process.env.DATA_DIR || "data");
const email = (process.argv[2] ?? process.env.SEED_EMAIL ?? "demo@example.com").toLowerCase();
let owner = await findUser(data, email);
if (!owner) {
  const password = randomToken(8);
  owner = await createUser(data, { email, name: "Demo creator", password });
  console.log(`Created ${email} with password: ${password}`);
}
const tour = await seedSampleTour(data, owner.id);
console.log(`Sample tour "${tour.title}": http://localhost:${process.env.PORT ?? 3000}/t/${tour.slug}  (edit it at /editor after signing in as ${email})`);
data.db.close();
