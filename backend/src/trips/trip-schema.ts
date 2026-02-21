import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, decimal, integer, varchar } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const tripStatuses = ["SUBMITTED", "STARTED", "ENDED"] as const;
export type TripStatus = typeof tripStatuses[number];

export const trips = pgTable("trips", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  intutrackTripId: text("intutrack_trip_id").unique(),
  truckNumber: text("truck_number"),
  invoice: text("invoice"),
  srcLat: decimal("src_lat", { precision: 10, scale: 6 }),
  srcLng: decimal("src_lng", { precision: 10, scale: 6 }),
  destLat: decimal("dest_lat", { precision: 10, scale: 6 }),
  destLng: decimal("dest_lng", { precision: 10, scale: 6 }),
  tel: text("tel"),
  status: text("status").default("SUBMITTED"),
  etaHrs: integer("eta_hrs"),
  trackingState: text("tracking_state"),
  startedAt: timestamp("started_at"),
  endedAt: timestamp("ended_at"),
  publicLink: text("public_link"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertTripSchema = createInsertSchema(trips).omit({
  id: true,
  createdAt: true,
});

export type InsertTrip = z.infer<typeof insertTripSchema>;
export type Trip = typeof trips.$inferSelect;
