import { webcrypto } from "node:crypto";
import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import session from "express-session";
// @ts-ignore
import connectPgSimple from "connect-pg-simple";
import { pool } from "./db";
import { storage } from "./storage";
import { db } from "./db";
import { eq, and, or, gt } from "drizzle-orm";
import { 
  insertUserSchema, insertLoadSchema, insertTruckSchema, insertDriverSchema, insertBidSchema,
  insertCarrierVerificationSchema, insertCarrierVerificationDocumentSchema, insertBidNegotiationSchema, insertShipperInvoiceResponseSchema,
  trucks as trucksTable,
  carrierProfiles as carrierProfilesTable,
  loads as loadsTable,
  shipments as shipmentsTable,
  ratings,
  shipperRatings,
  insertShipperRatingSchema,
  carrierRatings,
  insertCarrierRatingSchema,
  savedAddresses,
  insertSavedAddressSchema,
  users,
  shipperOnboardingRequests,
  invoices as invoicesTable,
  otpVerifications,
} from "@shared/schema";
import { z } from "zod";
import { 
  getLoadsForRole, 
  checkCarrierEligibility, 
  canUserBidOnLoad, 
  acceptBid, 
  rejectBid,
  transitionLoadState,
  checkCarrierDocumentCompliance
} from "./workflow-service";
import twilio from "twilio";
import { setupTelemetryWebSocket } from "./websocket-telemetry";
import { 
  broadcastLoadPosted, 
  broadcastLoadSubmitted,
  broadcastLoadUpdated, 
  broadcastBidReceived,
  broadcastBidCountered,
  broadcastBidAccepted,
  broadcastInvoiceEvent,
  broadcastNegotiationMessage,
  broadcastVerificationStatus,
  broadcastMarketplaceEvent,
  broadcastToUser,
  broadcastRatingReceived
} from "./websocket-marketplace";
import {
  getAllVehiclesTelemetry,
  getVehicleTelemetry,
  getEtaPrediction,
  getGpsBreadcrumbs,
  getDriverBehaviorScore,
  checkTelemetryAlerts,
  getActiveVehicleIds,
} from "./telemetry-simulator";
import {
  calculateFromMargin,
  calculateFromPayout,
  validatePricing,
} from "@shared/pricing";
import { registerHelpBotRoutes } from "./helpbot-routes";

declare module 'express-serve-static-core' {
  interface Request {
    session?: any;
  }
}

const hashPassword = async (password: string): Promise<string> => {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await webcrypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
const twilioVerifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
const twilioClient = twilioAccountSid && twilioAuthToken ? twilio(twilioAccountSid, twilioAuthToken) : null;

const normalizePhoneForTwilio = (phone: string) => {
  const cleaned = phone.trim().replace(/[^\d+]/g, "");
  if (cleaned.startsWith("+")) return cleaned;
  const digits = cleaned.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return phone;
};

const canUseTwilioVerify = () => Boolean(twilioClient && twilioVerifyServiceSid);

const sendTwilioOtp = async (phone: string) => {
  if (!twilioClient || !twilioVerifyServiceSid) {
    throw new Error("Twilio Verify is not configured");
  }
  const to = normalizePhoneForTwilio(phone);
  await twilioClient.verify.v2.services(twilioVerifyServiceSid).verifications.create({
    to,
    channel: "sms",
  });
};

const checkTwilioOtp = async (phone: string, code: string) => {
  if (!twilioClient || !twilioVerifyServiceSid) {
    throw new Error("Twilio Verify is not configured");
  }
  const to = normalizePhoneForTwilio(phone);
  const result = await twilioClient.verify.v2.services(twilioVerifyServiceSid).verificationChecks.create({
    to,
    code,
  });
  return result.status === "approved";
};

const maskPhone = (phone: string) => {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return "unknown";
  if (digits.length <= 4) return "*".repeat(digits.length);
  return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
};

const getRecentOtpRequestCount = async (phone: string, otpType: string) => {
  const since = new Date(Date.now() - 15 * 60 * 1000);
  const recent = await db.select({ id: otpVerifications.id })
    .from(otpVerifications)
    .where(and(
      eq(otpVerifications.phoneNumber, phone),
      eq(otpVerifications.otpType, otpType),
      gt(otpVerifications.createdAt, since)
    ));
  return recent.length;
};

// Document type labels for notification messages
const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  rc: "RC (Registration Certificate)",
  insurance: "Vehicle Insurance",
  fitness: "Fitness Certificate",
  permit: "National / State Permit",
  puc: "PUC Certificate",
  road_tax: "Road Tax / Challan Clearance",
  license: "Driving License",
  pan: "PAN Card",
  gst: "GST Certificate",
  aadhar: "Aadhaar Card",
  aadhaar: "Aadhaar Card",
  fleet_proof: "Fleet Ownership Proof",
  aadhaar_card: "Aadhaar Card",
  driver_license: "Driver License",
  permit_document: "Permit Document",
  insurance_certificate: "Insurance Certificate",
  fitness_certificate: "Fitness Certificate",
  incorporation_certificate: "Incorporation Certificate",
  incorporation: "Incorporation Certificate",
  trade_license: "Trade License",
  address_proof: "Business Address Proof",
  pan_card: "PAN Card",
  gstin_certificate: "GSTIN Certificate",
  gstin: "GSTIN Certificate",
  tan_certificate: "TAN Certificate",
  tan: "TAN Certificate",
  tds_declaration: "TDS Declaration",
  void_cheque: "Void Cheque / Cancelled Cheque",
};

declare module "express-session" {
  interface SessionData {
    userId: string;
  }
}

const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  // Trust proxy for production (Replit uses reverse proxy)
  if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }
  
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction) {
    app.use((req, res, next) => {
      const forwardedProto = req.headers["x-forwarded-proto"];
      if (req.secure || forwardedProto === "https") {
        return next();
      }
      return res.status(403).json({ error: "HTTPS required" });
    });
  }
  
  // Use PostgreSQL session store for production persistence
  const PgSession = connectPgSimple(session);
  
  app.use(
    session({
      store: new PgSession({
        pool: pool,
        tableName: "session",
        createTableIfMissing: true,
      }),
      secret: process.env.SESSION_SECRET || "loadsmart-secret-key-change-in-production",
      resave: false,
      saveUninitialized: false,
      proxy: true,
      cookie: {
        secure: false,
        httpOnly: true,
        maxAge: 7 * 24 * 60 * 60 * 1000,
        sameSite: "lax",
        domain: undefined,
      },
    })
  );

  registerHelpBotRoutes(app);

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.post("/api/auth/register", async (req, res) => {
    try {
      const { otpId, ...userData } = req.body;
      const data = insertUserSchema.parse(userData);
      const isDevBypass = process.env.NODE_ENV !== "production";

      if (!isDevBypass) {
        // All users must verify their phone number with OTP
        if (!otpId) {
          return res.status(400).json({ error: "Phone verification required for registration" });
        }
        
        const otpRecord = await storage.getOtpVerification(otpId);
        if (!otpRecord) {
          return res.status(400).json({ error: "OTP verification not found. Please verify your phone again." });
        }
        
        if (otpRecord.status !== "verified") {
          console.log(`[Register] OTP status check failed. Status: ${otpRecord.status}, ID: ${otpId}`);
          return res.status(400).json({ error: `Phone verification expired or already used. Please verify your phone again.` });
        }
        
        const normalizePhone = (p: string) => p.replace(/[\s\-\+]/g, "").slice(-10);
        if (normalizePhone(otpRecord.phoneNumber || "") !== normalizePhone(data.phone || "")) {
          return res.status(400).json({ error: "Phone number mismatch. The verified phone number doesn't match the one provided." });
        }
        
        // Clean up used OTP by marking it as consumed
        await storage.updateOtpVerification(otpId, { status: "consumed" });
      }
      
      const existingUser = await storage.getUserByUsername(data.username);
      if (existingUser) {
        return res.status(400).json({ error: "Username already exists" });
      }
      
      if (data.email && data.email.trim() !== "") {
        const existingEmail = await storage.getUserByEmail(data.email);
        if (existingEmail) {
          return res.status(400).json({ error: "Email already exists" });
        }
      }

      const hashedPassword = await hashPassword(data.password);
      let user = await storage.createUser({
        ...data,
        password: hashedPassword,
      });

      // Admins are always verified automatically (dev bypass verifies all users)
      if (user.role === "admin" || isDevBypass) {
        const updatedUser = await storage.updateUser(user.id, { isVerified: true });
        if (updatedUser) {
          user = updatedUser;
        }
      }

      if (user.role === "carrier") {
        // Get carrierType from registration data (solo or enterprise)
        const carrierType = req.body.carrierType || "enterprise";
        const isSolo = carrierType === "solo";
        
        await storage.createCarrierProfile({
          userId: user.id,
          carrierType: carrierType,
          companyName: isSolo ? undefined : req.body.companyName,
          companyPhone: isSolo ? undefined : req.body.companyPhone,
          city: req.body.city || null,
          fleetSize: isSolo ? 1 : 0,
          serviceZones: [],
          reliabilityScore: "0",
          communicationScore: "0",
          onTimeScore: "0",
          totalDeliveries: 0,
          badgeLevel: "bronze",
          bio: null,
        });
      }

      // Auto-create draft onboarding request for shippers (only if none exists)
      if (user.role === "shipper") {
        const existingRequest = await storage.getShipperOnboardingRequest(user.id);
        if (!existingRequest) {
          await storage.createShipperOnboardingRequest({
            shipperId: user.id,
            status: "draft",
          });
        }
      }

      req.session.userId = user.id;
      
      const { password: _, ...userWithoutPassword } = user;
      
      // Broadcast new user registration to admins for real-time updates
      broadcastMarketplaceEvent("user_registered", {
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role,
          companyName: user.companyName,
          createdAt: user.createdAt,
        },
      });
      
      res.json({ user: userWithoutPassword });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Registration error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Helper function to seed AI-generated sample documents for demo accounts
  async function seedSampleDocumentsForSoloDriver(user: any) {
    // Only seed for solodriver1 test account
    if (user.username !== "solodriver1") return;
    
    // Check if documents already exist - don't seed if there are any documents
    const existingDocs = await storage.getDocumentsByUser(user.id);
    if (existingDocs.length > 0) return; // Already has documents, don't add duplicates
    
    console.log("Seeding AI-generated sample documents for solodriver1...");
    
    const aiCertificateImages = {
      license: "/assets/generated_images/indian_driving_license_card.png",
      rc: "/assets/generated_images/indian_rc_book_certificate.png",
      insurance: "/assets/generated_images/indian_vehicle_insurance_policy.png",
      fitness: "/assets/generated_images/indian_vehicle_fitness_certificate.png",
      permit: "/assets/generated_images/indian_national_transport_permit.png",
      puc: "/assets/generated_images/indian_puc_certificate_document.png",
    };
    
    const sampleDocuments = [
      {
        userId: user.id,
        documentType: "license",
        fileName: "DL_Solo_Transport_MH12_AI_Generated.png",
        fileUrl: aiCertificateImages.license,
        fileSize: 256000,
        expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
        isVerified: true,
      },
      {
        userId: user.id,
        documentType: "rc",
        fileName: "RC_Book_Solo_Transport_MH12AB1234_AI_Generated.png",
        fileUrl: aiCertificateImages.rc,
        fileSize: 334000,
        expiryDate: new Date(Date.now() + 730 * 24 * 60 * 60 * 1000), // 2 years
        isVerified: true,
      },
      {
        userId: user.id,
        documentType: "insurance",
        fileName: "Insurance_Policy_Solo_Transport_AI_Generated.png",
        fileUrl: aiCertificateImages.insurance,
        fileSize: 412000,
        expiryDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000), // 15 days (expiring soon)
        isVerified: false,
      },
      {
        userId: user.id,
        documentType: "fitness",
        fileName: "Fitness_Certificate_Solo_Transport_AI_Generated.png",
        fileUrl: aiCertificateImages.fitness,
        fileSize: 289000,
        expiryDate: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000), // 6 months
        isVerified: true,
      },
      {
        userId: user.id,
        documentType: "permit",
        fileName: "National_Permit_Solo_Transport_AI_Generated.png",
        fileUrl: aiCertificateImages.permit,
        fileSize: 367000,
        expiryDate: new Date(Date.now() + 545 * 24 * 60 * 60 * 1000), // 18 months
        isVerified: true,
      },
      {
        userId: user.id,
        documentType: "puc",
        fileName: "PUC_Certificate_Solo_Transport_AI_Generated.png",
        fileUrl: aiCertificateImages.puc,
        fileSize: 198000,
        expiryDate: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), // Expired 10 days ago
        isVerified: false,
      },
    ];
    
    for (const docData of sampleDocuments) {
      await storage.createDocument(docData);
    }
    console.log("Sample documents seeded successfully for solodriver1");
  }

  app.post("/api/auth/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      
      // Try to find user by username, email, or phone
      let user = await storage.getUserByUsername(username);
      if (!user) {
        user = await storage.getUserByEmail(username);
      }
      if (!user) {
        user = await storage.getUserByPhone(username);
      }
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const hashedPassword = await hashPassword(password);
      
      console.log(`[Login Debug] Attempting login for ${username}`);
      console.log(`[Login Debug] Found user: ${user ? user.username : 'none'} (ID: ${user?.id})`);
      console.log(`[Login Debug] Stored hash: ${user?.password}`);
      console.log(`[Login Debug] Computed hash: ${hashedPassword}`);
      
      if (user.password !== hashedPassword) {
        console.log(`[Login Debug] Password mismatch`);
        return res.status(401).json({ error: "Invalid credentials" });
      }
      
      await storage.updateUser(user.id, { lastActiveAt: new Date() } as any);
      
      if (user.role === "carrier") {
        await seedSampleDocumentsForSoloDriver(user);
      }
      
      // Set session userId to authenticate the user
      req.session.userId = user.id;
      
      const { password: _, ...userWithoutPassword } = user;
      
      // Include carrierType for carrier users - prioritize explicit type over fleet size
      let carrierType: string | undefined;
      if (user.role === "carrier") {
        const carrierProfile = await storage.getCarrierProfile(user.id);
        const dbCarrierType = carrierProfile?.carrierType;
        const fleetSize = carrierProfile?.fleetSize;
        
        // Prioritize explicit carrier_type from database
        if (dbCarrierType === "solo") {
          carrierType = "solo";
        } else if (dbCarrierType === "enterprise" || dbCarrierType === "fleet") {
          carrierType = "enterprise"; // Both "enterprise" and "fleet" show enterprise portal
        } else {
          // Only auto-detect if carrier_type is not explicitly set
          // fleetSize of 0 or 1 defaults to solo for new registrations without explicit type
          const isSoloByFleetSize = typeof fleetSize === "number" && fleetSize <= 1;
          carrierType = isSoloByFleetSize ? "solo" : "enterprise";
        }
      }
      
      res.json({ user: { ...userWithoutPassword, carrierType } });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Forgot Password - Send reset OTP to email or phone
  app.post("/api/auth/forgot-password", async (req, res) => {
    try {
      const { emailOrPhone } = req.body;
      
      if (!emailOrPhone) {
        return res.status(400).json({ error: "Email or phone number is required" });
      }
      
      // Try to find user by email or phone
      let user = await storage.getUserByEmail(emailOrPhone);
      if (!user) {
        // Try by phone (normalize with/without +91)
        const normalizedPhone = emailOrPhone.startsWith("+91") ? emailOrPhone : `+91${emailOrPhone.replace(/\D/g, '')}`;
        const users = await storage.getAllUsers();
        user = users.find(u => u.phone === normalizedPhone || u.phone === emailOrPhone);
      }
      
      if (!user) {
        // Don't reveal if user exists for security
        return res.json({ 
          success: true, 
          message: "If an account exists with this email or phone, you will receive a reset code.",
          otpId: null
        });
      }
      
      const isEmail = emailOrPhone.includes("@");
      const targetPhone = user.phone || emailOrPhone;
      const useTwilio = !isEmail && canUseTwilioVerify() && !!targetPhone;
      const otpCode = useTwilio ? "twilio" : Math.floor(100000 + Math.random() * 900000).toString();
      
      // Calculate expiry (15 minutes for password reset)
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
      
      // Store OTP in database
      const otpRecord = await storage.createOtpVerification({
        otpType: "password_reset",
        otpCode: otpCode,
        userId: user.id,
        phoneNumber: user.phone || (isEmail ? null : targetPhone),
        status: "pending",
        validityMinutes: 15,
        expiresAt: expiresAt,
      });

      if (useTwilio && targetPhone) {
        await sendTwilioOtp(targetPhone);
      }

      const maskedContact = isEmail 
        ? emailOrPhone.replace(/(.{2})(.*)(@.*)/, '$1***$3')
        : emailOrPhone.replace(/(.{3})(.*)(.{4})/, '$1****$3');
      
      res.json({ 
        success: true, 
        message: `Reset code sent to ${maskedContact}`,
        otpId: otpRecord.id,
        method: isEmail ? "email" : "phone",
        ...(useTwilio ? {} : { demoOtp: otpCode })
      });
    } catch (error) {
      console.error("Forgot password error:", error);
      res.status(500).json({ error: "Failed to process request" });
    }
  });

  // Verify Password Reset OTP
  app.post("/api/auth/verify-reset-otp", async (req, res) => {
    try {
      const { otpId, otpCode } = req.body;
      
      if (!otpId || !otpCode) {
        return res.status(400).json({ error: "OTP ID and code are required" });
      }
      
      const otpRecord = await storage.getOtpVerification(otpId);
      
      if (!otpRecord) {
        return res.status(400).json({ error: "Invalid reset request" });
      }
      
      if (otpRecord.otpType !== "password_reset") {
        return res.status(400).json({ error: "Invalid reset request" });
      }
      
      if (otpRecord.status !== "pending") {
        return res.status(400).json({ error: "This reset code has already been used or expired" });
      }
      
      if (new Date() > new Date(otpRecord.expiresAt)) {
        await storage.updateOtpVerification(otpId, { status: "expired" });
        return res.status(400).json({ error: "Reset code has expired. Please request a new one." });
      }
      
      if ((otpRecord.attempts || 0) >= 5) {
        await storage.updateOtpVerification(otpId, { status: "expired" });
        return res.status(400).json({ error: "Too many attempts. Please request a new code." });
      }

      const cleanOtpCode = String(otpCode).trim();
      if (canUseTwilioVerify() && otpRecord.phoneNumber) {
        const approved = await checkTwilioOtp(otpRecord.phoneNumber, cleanOtpCode);
        if (!approved) {
          await storage.updateOtpVerification(otpId, { attempts: (otpRecord.attempts || 0) + 1 });
          return res.status(400).json({ error: "Invalid code. Please try again." });
        }
        await storage.updateOtpVerification(otpId, { 
          status: "verified",
          verifiedAt: new Date()
        });
      } else {
        if (otpRecord.otpCode !== cleanOtpCode) {
          await storage.updateOtpVerification(otpId, { attempts: (otpRecord.attempts || 0) + 1 });
          return res.status(400).json({ error: "Invalid code. Please try again." });
        }
        await storage.updateOtpVerification(otpId, { 
          status: "verified",
          verifiedAt: new Date()
        });
      }
      
      res.json({ 
        success: true, 
        message: "Code verified successfully",
        userId: otpRecord.userId
      });
    } catch (error) {
      console.error("Verify reset OTP error:", error);
      res.status(500).json({ error: "Failed to verify code" });
    }
  });

  // Reset Password
  app.post("/api/auth/reset-password", async (req, res) => {
    try {
      const { otpId, newPassword } = req.body;
      
      if (!otpId || !newPassword) {
        return res.status(400).json({ error: "OTP ID and new password are required" });
      }
      
      if (newPassword.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters" });
      }
      
      const otpRecord = await storage.getOtpVerification(otpId);
      
      if (!otpRecord) {
        return res.status(400).json({ error: "Invalid reset request" });
      }
      
      if (otpRecord.status !== "verified") {
        return res.status(400).json({ error: "Please verify your code first" });
      }
      
      if (!otpRecord.userId) {
        return res.status(400).json({ error: "Invalid reset request" });
      }
      
      // Check expiry again (15 min window after verification)
      const verifiedAt = otpRecord.verifiedAt ? new Date(otpRecord.verifiedAt) : new Date();
      if (Date.now() - verifiedAt.getTime() > 15 * 60 * 1000) {
        await storage.updateOtpVerification(otpId, { status: "expired" });
        return res.status(400).json({ error: "Reset session expired. Please start over." });
      }
      
      // Hash new password and update user
      const hashedPassword = await hashPassword(newPassword);
      await storage.updateUser(otpRecord.userId, { password: hashedPassword });
      
      // Mark OTP as consumed
      await storage.updateOtpVerification(otpId, { status: "consumed" });
      
      res.json({ 
        success: true, 
        message: "Password reset successfully. You can now login with your new password."
      });
    } catch (error) {
      console.error("Reset password error:", error);
      res.status(500).json({ error: "Failed to reset password" });
    }
  });

  app.get("/api/auth/me", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const user = await storage.getUser(req.session.userId);
      if (!user) {
        req.session.destroy(() => {});
        return res.status(401).json({ error: "User not found" });
      }

      const { password: _, ...userWithoutPassword } = user;
      
      // Include carrierType for carrier users - prioritize explicit type over fleet size
      let carrierType: string | undefined;
      if (user.role === "carrier") {
        const carrierProfile = await storage.getCarrierProfile(user.id);
        const dbCarrierType = carrierProfile?.carrierType;
        const fleetSize = carrierProfile?.fleetSize;
        
        // Prioritize explicit carrier_type from database
        if (dbCarrierType === "solo") {
          carrierType = "solo";
        } else if (dbCarrierType === "enterprise" || dbCarrierType === "fleet") {
          carrierType = "enterprise"; // Both "enterprise" and "fleet" show enterprise portal
        } else {
          // Only auto-detect if carrier_type is not explicitly set
          // fleetSize of 0 or 1 defaults to solo for new registrations without explicit type
          const isSoloByFleetSize = typeof fleetSize === "number" && fleetSize <= 1;
          carrierType = isSoloByFleetSize ? "solo" : "enterprise";
        }
      }
      
      res.json({ user: { ...userWithoutPassword, carrierType } });
    } catch (error) {
      console.error("Auth check error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err: any) => {
      if (err) {
        return res.status(500).json({ error: "Failed to logout" });
      }
      res.json({ success: true });
    });
  });

  // PATCH /api/user/profile - Update user profile (avatar, etc.)
  app.patch("/api/user/profile", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { avatar, companyName, phone } = req.body;
      const updates: Partial<{ avatar: string; companyName: string; phone: string }> = {};
      
      if (avatar !== undefined) updates.avatar = avatar;
      if (companyName !== undefined) updates.companyName = companyName;
      if (phone !== undefined) updates.phone = phone;

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No fields to update" });
      }

      await storage.updateUser(user.id, updates);
      
      const updatedUser = await storage.getUser(user.id);
      if (!updatedUser) {
        return res.status(404).json({ error: "User not found" });
      }

      const { password: _, ...userWithoutPassword } = updatedUser;
      res.json({ success: true, user: userWithoutPassword });
    } catch (error) {
      console.error("Update profile error:", error);
      res.status(500).json({ error: "Failed to update profile" });
    }
  });

  // GET /api/loads - Role-based load visibility (enforced at API level)
  app.get("/api/loads", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      // Use workflow service for role-based visibility
      const loadsList = await getLoadsForRole(user);

      const loadsWithBids = await Promise.all(
        loadsList.map(async (load) => {
          const loadBids = await storage.getBidsByLoad(load.id);
          
          // Fetch assigned carrier info if load has been awarded
          let assignedCarrierName: string | null = null;
          if (load.assignedCarrierId) {
            const carrierUser = await storage.getUser(load.assignedCarrierId);
            if (carrierUser) {
              // Get carrier profile to check type and get company name
              const carrierProfile = await storage.getCarrierProfile(load.assignedCarrierId);
              if (carrierProfile?.carrierType === 'solo') {
                // For solo drivers, use their name
                assignedCarrierName = carrierUser.username;
              } else {
                // For enterprise, use company name
                assignedCarrierName = carrierProfile?.companyName || carrierUser.companyName || carrierUser.username;
              }
            }
          }
          
          // Sync status with shipment: derive effective status from shipment if exists
          let effectiveStatus = load.status;
          if (load.assignedCarrierId && !["delivered", "closed", "in_transit"].includes(load.status || "")) {
            const shipment = await storage.getShipmentByLoad(load.id);
            if (shipment) {
              // Derive status from shipment state
              if (shipment.endOtpVerified) {
                effectiveStatus = "delivered";
              } else if (shipment.status === "in_transit" || shipment.startOtpVerified) {
                effectiveStatus = "in_transit";
              }
            }
          }
          
          return { ...load, status: effectiveStatus, bidCount: loadBids.length, assignedCarrierName };
        })
      );

      res.json(loadsWithBids);
    } catch (error) {
      console.error("Get loads error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/loads", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "shipper") {
        return res.status(403).json({ error: "Only shippers can post loads" });
      }

      const body = { ...req.body };
      if (body.pickupDate && typeof body.pickupDate === 'string') {
        body.pickupDate = new Date(body.pickupDate);
      }
      if (body.deliveryDate && typeof body.deliveryDate === 'string') {
        body.deliveryDate = new Date(body.deliveryDate);
      }
      if (typeof body.weight === 'string') {
        const parsed = parseFloat(body.weight);
        body.weight = (!body.weight || isNaN(parsed)) ? null : parsed;
      }

      // Get the next sequential load number for this shipper
      const shipperLoadNumber = await storage.getNextShipperLoadNumber(user.id);

      const data = insertLoadSchema.parse({
        ...body,
        pickupAddress: body.pickupAddress || "",
        pickupCity: body.pickupCity || "",
        dropoffAddress: body.dropoffAddress || "",
        dropoffCity: body.dropoffCity || "",
        shipperId: user.id,
        shipperLoadNumber,
      });

      const load = await storage.createLoad(data);
      
      // Broadcast to admins that a new load was submitted for pricing
      broadcastLoadSubmitted({
        id: load.id,
        pickupCity: load.pickupCity,
        dropoffCity: load.dropoffCity,
        shipperId: load.shipperId,
        shipperName: user.companyName || user.username,
        status: load.status,
      });
      
      // Notify shipper that their load was submitted successfully
      await storage.createNotification({
        userId: user.id,
        title: "Load Submitted",
        message: `Your load LD-${String(shipperLoadNumber).padStart(3, '0')}${load.pickupCity && load.dropoffCity ? ` from ${load.pickupCity} to ${load.dropoffCity}` : ''} has been submitted for pricing.`,
        type: "load",
        relatedLoadId: load.id,
      });
      
      res.json(load);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Create load error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/loads/:id", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const load = await storage.getLoad(req.params.id);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }
      
      // Fetch shipper and assigned carrier data for admin view (sanitized DTO with only required fields)
      let shipper: { id: string; username: string; email: string; company: string | null; phone: string | null; isVerified: boolean; role: string } | null = null;
      let assignedCarrier: { id: string; username: string; email: string; company: string | null; phone: string | null; isVerified: boolean; role: string } | null = null;
      
      if (load.shipperId) {
        const shipperUser = await storage.getUser(load.shipperId);
        if (shipperUser) {
          shipper = {
            id: shipperUser.id,
            username: shipperUser.username,
            email: shipperUser.email,
            company: shipperUser.companyName,
            phone: shipperUser.phone,
            isVerified: shipperUser.isVerified ?? false,
            role: shipperUser.role,
          };
        }
      }
      if (load.assignedCarrierId) {
        const carrierUser = await storage.getUser(load.assignedCarrierId);
        if (carrierUser) {
          assignedCarrier = {
            id: carrierUser.id,
            username: carrierUser.username,
            email: carrierUser.email,
            company: carrierUser.companyName,
            phone: carrierUser.phone,
            isVerified: carrierUser.isVerified ?? false,
            role: carrierUser.role,
          };
        }
      }
      
      // Fetch shipment with truck and driver details
      let shipmentDetails: {
        id: string;
        status: string;
        truckId: string | null;
        driverId: string | null;
        truck?: {
          id: string;
          licensePlate: string;
          manufacturer: string | null;
          model: string | null;
          truckType: string | null;
          capacity: string | null;
          chassisNumber: string | null;
          registrationNumber: string | null;
        } | null;
        driver?: {
          id: string;
          username: string;
          phone: string | null;
          email: string | null;
        } | null;
      } | null = null;
      
      const shipment = await storage.getShipmentByLoad(load.id);
      
      // Check carrier type for solo carrier handling
      let carrierProfile = null;
      if (load.assignedCarrierId) {
        carrierProfile = await storage.getCarrierProfile(load.assignedCarrierId);
      }
      const isSoloCarrier = carrierProfile?.carrierType === 'solo';
      
      if (shipment) {
        shipmentDetails = {
          id: shipment.id,
          status: shipment.status || "pending",
          truckId: shipment.truckId,
          driverId: shipment.driverId,
        };
        
        // Fetch truck details - first from shipment, then fallback to carrier's trucks
        let truck = null;
        if (shipment.truckId) {
          truck = await storage.getTruck(shipment.truckId);
        }
        
        // Fallback: For solo carriers, get their registered truck if not on shipment
        if (!truck && load.assignedCarrierId) {
          const carrierTrucks = await storage.getTrucksByCarrier(load.assignedCarrierId);
          if (carrierTrucks && carrierTrucks.length > 0) {
            truck = carrierTrucks[0]; // Use their primary truck
          }
        }
        
        if (truck) {
          shipmentDetails.truck = {
            id: truck.id,
            licensePlate: truck.licensePlate,
            manufacturer: truck.make,
            model: truck.model,
            truckType: truck.truckType,
            capacity: truck.capacity?.toString() || null,
            chassisNumber: truck.chassisNumber,
            registrationNumber: truck.registrationNumber,
          };
        }
        
        // Fetch driver details - for solo carriers, use carrier info as driver
        if (isSoloCarrier && assignedCarrier) {
          // Solo carriers drive their own truck
          shipmentDetails.driver = {
            id: assignedCarrier.id,
            username: (assignedCarrier as any).companyName || assignedCarrier.username,
            phone: assignedCarrier.phone,
            email: assignedCarrier.email,
          };
        } else if (shipment.driverId) {
          // Enterprise carriers have assigned drivers
          const driver = await storage.getDriver(shipment.driverId);
          if (driver) {
            shipmentDetails.driver = {
              id: driver.id,
              username: driver.name,
              phone: driver.phone,
              email: driver.email,
            };
          }
        }
      } else if (load.assignedCarrierId) {
        // No shipment yet, but carrier is assigned - fetch their registered truck/info for solo carriers
        if (isSoloCarrier) {
          const carrierTrucks = await storage.getTrucksByCarrier(load.assignedCarrierId);
          if (carrierTrucks && carrierTrucks.length > 0 || assignedCarrier) {
            shipmentDetails = {
              id: '',
              status: 'pending',
              truckId: carrierTrucks[0]?.id || null,
              driverId: null,
            };
            
            if (carrierTrucks.length > 0) {
              const truck = carrierTrucks[0];
              shipmentDetails.truck = {
                id: truck.id,
                licensePlate: truck.licensePlate,
                manufacturer: truck.make,
                model: truck.model,
                truckType: truck.truckType,
                capacity: truck.capacity?.toString() || null,
                chassisNumber: truck.chassisNumber,
                registrationNumber: truck.registrationNumber,
              };
            }
            
            if (assignedCarrier) {
              shipmentDetails.driver = {
                id: assignedCarrier.id,
                username: (assignedCarrier as any).companyName || assignedCarrier.username,
                phone: assignedCarrier.phone,
                email: assignedCarrier.email,
              };
            }
          }
        }
      }
      
      // Fetch carrier profile details
      let carrierOnboarding: {
        carrierType: string | null;
        fleetSize: number | null;
      } | null = null;
      
      if (load.assignedCarrierId) {
        const profile = await storage.getCarrierProfile(load.assignedCarrierId);
        if (profile) {
          carrierOnboarding = {
            carrierType: profile.carrierType,
            fleetSize: profile.fleetSize,
          };
        }
      }
      
      // Admin-as-Mediator: Shippers can only see bids on finalized loads
      const isFinalized = ["assigned", "in_transit", "delivered"].includes(load.status || "");
      const shouldIncludeBids = user.role !== "shipper" || isFinalized;
      
      if (shouldIncludeBids) {
        const loadBids = await storage.getBidsByLoad(load.id);
        res.json({ ...load, bids: loadBids, shipper, assignedCarrier, shipmentDetails, carrierOnboarding });
      } else {
        // Hide bids and pricing info from shippers pre-finalization
        res.json({ ...load, bids: [], bidCount: 0, shipper, assignedCarrier, shipmentDetails, carrierOnboarding });
      }
    } catch (error) {
      console.error("Get load error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/loads/:id/history - Get load state change history
  app.get("/api/loads/:id/history", requireAuth, async (req, res) => {
    try {
      const load = await storage.getLoad(req.params.id);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }
      const history = await storage.getLoadStateHistory(req.params.id);
      res.json(history);
    } catch (error) {
      console.error("Get load history error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.patch("/api/loads/:id", requireAuth, async (req, res) => {
    try {
      const body = { ...req.body };
      if (body.pickupDate && typeof body.pickupDate === 'string') {
        body.pickupDate = new Date(body.pickupDate);
      }
      if (body.deliveryDate && typeof body.deliveryDate === 'string') {
        body.deliveryDate = new Date(body.deliveryDate);
      }
      
      const load = await storage.updateLoad(req.params.id, body);
      
      // Broadcast load update to admin portal for real-time sync
      if (load) {
        broadcastLoadUpdated(load.id, load.shipperId, load.status, "load_edited", {
          id: load.id,
          status: load.status,
          pickupCity: load.pickupCity,
          dropoffCity: load.dropoffCity,
          weight: load.weight,
          materialType: load.materialType,
          pickupDate: load.pickupDate,
          deliveryDate: load.deliveryDate,
        });
      }
      
      res.json(load);
    } catch (error) {
      console.error("Update load error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/trucks", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const trucksList = await storage.getTrucksByCarrier(user.id);
      
      // Add availability info for fleet carriers
      const carrierProfile = await storage.getCarrierProfile(user.id);
      const isFleetCarrier = carrierProfile?.carrierType === 'enterprise' || carrierProfile?.carrierType === 'fleet';
      
      if (isFleetCarrier) {
        // Get active shipments and accepted bids to determine truck availability
        const terminalStatuses = ['delivered', 'closed', 'cancelled', 'completed'];
        const carrierShipments = await storage.getShipmentsByCarrier(user.id);
        const allBids = await storage.getBidsByCarrier(user.id);
        
        // Find trucks in active shipments (not in terminal status)
        const trucksInActiveShipments = new Set(
          carrierShipments
            .filter(s => s.truckId && !terminalStatuses.includes(s.status || ''))
            .map(s => s.truckId)
        );
        
        // Create a set of load IDs that have shipments in terminal status
        const loadsWithCompletedShipments = new Set(
          carrierShipments
            .filter(s => terminalStatuses.includes(s.status || ''))
            .map(s => s.loadId)
        );
        
        // Find trucks in accepted bids where shipment is NOT yet completed
        // If a bid's load has a shipment in terminal status, the truck should be available
        const trucksInAcceptedBids = new Set(
          allBids
            .filter(b => b.truckId && b.status === 'accepted' && !loadsWithCompletedShipments.has(b.loadId))
            .map(b => b.truckId)
        );
        
        // Add availability flag to each truck
        const trucksWithAvailability = trucksList.map(truck => ({
          ...truck,
          isAvailable: !trucksInActiveShipments.has(truck.id) && !trucksInAcceptedBids.has(truck.id),
          unavailableReason: trucksInActiveShipments.has(truck.id) || trucksInAcceptedBids.has(truck.id) 
            ? 'Assigned to active shipment' 
            : null
        }));
        
        return res.json(trucksWithAvailability);
      }
      
      res.json(trucksList);
    } catch (error) {
      console.error("Get trucks error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/trucks", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Only carriers can add trucks" });
      }

      const data = insertTruckSchema.parse({
        ...req.body,
        carrierId: user.id,
      });

      const truck = await storage.createTruck(data);
      res.json(truck);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Create truck error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.patch("/api/trucks/:id", requireAuth, async (req, res) => {
    try {
      const updates = { ...req.body };
      
      // Convert date strings to Date objects for expiry fields
      const dateFields = ['insuranceExpiry', 'fitnessExpiry', 'permitExpiry', 'pucExpiry', 'lastServiceDate', 'nextServiceDue'];
      for (const field of dateFields) {
        if (updates[field] && typeof updates[field] === 'string') {
          updates[field] = new Date(updates[field]);
        }
      }
      
      const truck = await storage.updateTruck(req.params.id, updates);
      res.json(truck);
    } catch (error) {
      console.error("Update truck error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/trucks/:id", requireAuth, async (req, res) => {
    try {
      await storage.deleteTruck(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Delete truck error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =============================================
  // DRIVERS ENDPOINTS (Enterprise Carriers)
  // =============================================

  app.get("/api/drivers", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      // Only enterprise carriers can manage drivers - check carrier_profiles table
      const carrierProfile = await storage.getCarrierProfile(user.id);
      if (!carrierProfile || carrierProfile.carrierType !== "enterprise") {
        return res.status(403).json({ error: "Driver management is only available for enterprise carriers" });
      }

      const driversList = await storage.getDriversByCarrier(user.id);
      
      // Add availability info for fleet carriers
      const terminalStatuses = ['delivered', 'closed', 'cancelled', 'completed'];
      const carrierShipments = await storage.getShipmentsByCarrier(user.id);
      const allBids = await storage.getBidsByCarrier(user.id);
      
      // Find drivers in active shipments (not in terminal status)
      const driversInActiveShipments = new Set(
        carrierShipments
          .filter(s => s.driverId && !terminalStatuses.includes(s.status || ''))
          .map(s => s.driverId)
      );
      
      // Create a set of load IDs that have shipments in terminal status
      const loadsWithCompletedShipments = new Set(
        carrierShipments
          .filter(s => terminalStatuses.includes(s.status || ''))
          .map(s => s.loadId)
      );
      
      // Find drivers in accepted bids where shipment is NOT yet completed
      // If a bid's load has a shipment in terminal status, the driver should be available
      const driversInAcceptedBids = new Set(
        allBids
          .filter(b => b.driverId && b.status === 'accepted' && !loadsWithCompletedShipments.has(b.loadId))
          .map(b => b.driverId)
      );
      
      // Add availability flag to each driver
      const driversWithAvailability = driversList.map(driver => ({
        ...driver,
        isAvailable: !driversInActiveShipments.has(driver.id) && !driversInAcceptedBids.has(driver.id),
        unavailableReason: driversInActiveShipments.has(driver.id) || driversInAcceptedBids.has(driver.id) 
          ? 'Assigned to active shipment' 
          : null
      }));
      
      res.json(driversWithAvailability);
    } catch (error) {
      console.error("Get drivers error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/drivers", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      // Only enterprise carriers can manage drivers - check carrier_profiles table
      const carrierProfile = await storage.getCarrierProfile(user.id);
      if (!carrierProfile || carrierProfile.carrierType !== "enterprise") {
        return res.status(403).json({ error: "Driver management is only available for enterprise carriers" });
      }

      // Convert date string to Date object if present
      const driverData = {
        ...req.body,
        carrierId: user.id,
        licenseExpiry: req.body.licenseExpiry ? new Date(req.body.licenseExpiry) : null,
      };

      const data = insertDriverSchema.parse(driverData);

      const driver = await storage.createDriver(data);
      res.json(driver);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Create driver error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.patch("/api/drivers/:id", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      // Verify driver belongs to this carrier
      const driver = await storage.getDriver(req.params.id);
      if (!driver || driver.carrierId !== user.id) {
        return res.status(404).json({ error: "Driver not found" });
      }

      // Convert date string to Date object if present
      const updateData = {
        ...req.body,
        licenseExpiry: req.body.licenseExpiry ? new Date(req.body.licenseExpiry) : undefined,
      };

      const updated = await storage.updateDriver(req.params.id, updateData);
      res.json(updated);
    } catch (error) {
      console.error("Update driver error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.delete("/api/drivers/:id", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      // Verify driver belongs to this carrier
      const driver = await storage.getDriver(req.params.id);
      if (!driver || driver.carrierId !== user.id) {
        return res.status(404).json({ error: "Driver not found" });
      }

      await storage.deleteDriver(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Delete driver error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/bids", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      let bidsList;
      if (user.role === "carrier") {
        bidsList = await storage.getBidsByCarrier(user.id);
      } else if (user.role === "shipper") {
        // Admin-as-Mediator: Shippers can only see bids on finalized loads (assigned, in_transit, delivered)
        const shipperLoads = await storage.getLoadsByShipper(user.id);
        const finalizedLoads = shipperLoads.filter(load => 
          ["assigned", "in_transit", "delivered"].includes(load.status || "")
        );
        const allBids = await Promise.all(
          finalizedLoads.map(load => storage.getBidsByLoad(load.id))
        );
        bidsList = allBids.flat();
      } else {
        bidsList = await storage.getAllBids();
      }
      
      // For admin, get latest negotiation amounts for all bids (real-time from chat)
      const bidIds = bidsList.map(b => b.id);
      const latestNegotiationAmounts = user.role === "admin" 
        ? await storage.getLatestNegotiationAmountsForBids(bidIds)
        : new Map<string, string>();
      
      // Debug: Log the amounts map
      console.log('[DEBUG] latestNegotiationAmounts map size:', latestNegotiationAmounts.size);
      if (latestNegotiationAmounts.size > 0) {
        console.log('[DEBUG] latestNegotiationAmounts entries:', Array.from(latestNegotiationAmounts.entries()));
      }

      const bidsWithDetails = await Promise.all(
        bidsList.map(async (bid) => {
          const carrier = await storage.getUser(bid.carrierId);
          const load = await storage.getLoad(bid.loadId);
          const truck = bid.truckId ? await storage.getTruck(bid.truckId) : null;
          const driver = bid.driverId ? await storage.getDriver(bid.driverId) : null;
          const carrierProfile = await storage.getCarrierProfile(bid.carrierId);
          const { password: _, ...carrierWithoutPassword } = carrier || {};
          
          // Include latest negotiation amount from chat (real-time)
          const latestNegotiationAmount = latestNegotiationAmounts.get(bid.id) || null;
          
          return { 
            ...bid, 
            // Override counterAmount with latest negotiation amount if available (for live margin calculation)
            latestNegotiationAmount,
            carrier: {
              ...carrierWithoutPassword,
              carrierType: carrierProfile?.carrierType || "enterprise"
            }, 
            load,
            truck,
            driver
          };
        })
      );

      res.json(bidsWithDetails);
    } catch (error) {
      console.error("Get bids error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Dedicated carrier bids endpoint with load details
  app.get("/api/carrier/bids", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Only carriers can access this endpoint" });
      }

      const bidsList = await storage.getBidsByCarrier(user.id);
      
      const bidsWithDetails = await Promise.all(
        bidsList.map(async (bid) => {
          const load = await storage.getLoad(bid.loadId);
          
          // Get the latest counter offers from negotiations
          // Counter offers can be stored as 'counter_offer' or 'message' with an amount
          const negotiations = await storage.getBidNegotiations(bid.id);
          
          // Get all messages with amounts, sorted by most recent first
          const messagesWithAmounts = negotiations
            .filter(n => n.amount && parseFloat(n.amount.toString()) > 0)
            .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
          
          // Carrier's latest offer
          const carrierMessages = messagesWithAmounts.filter(n => n.senderRole === "carrier");
          const latestCarrierAmount = carrierMessages.length > 0 
            ? carrierMessages[0].amount 
            : null;
          
          // Admin's latest offer
          const adminMessages = messagesWithAmounts.filter(n => n.senderRole === "admin");
          const latestAdminAmount = adminMessages.length > 0 
            ? adminMessages[0].amount 
            : null;
          
          // The absolute latest negotiation amount from either party
          const latestNegotiationAmount = messagesWithAmounts.length > 0 
            ? messagesWithAmounts[0].amount 
            : null;
          
          return { 
            ...bid, 
            load,
            latestCarrierAmount, // Carrier's latest counter offer
            latestAdminAmount,   // Admin's latest counter offer
            latestNegotiationAmount, // Most recent amount from either party
          };
        })
      );

      res.json(bidsWithDetails);
    } catch (error) {
      console.error("Get carrier bids error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Carrier responds to admin counter offer with counter-response
  app.post("/api/carrier/bids/:bidId/counter", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Only carriers can respond to bids" });
      }

      const { bidId } = req.params;
      const counterSchema = z.object({
        amount: z.number(),
        message: z.string().optional(),
      });

      const { amount, message } = counterSchema.parse(req.body);

      const bid = await storage.getBid(bidId);
      if (!bid) {
        return res.status(404).json({ error: "Bid not found" });
      }

      if (bid.carrierId !== user.id) {
        return res.status(403).json({ error: "You can only respond to your own bids" });
      }

      const load = await storage.getLoad(bid.loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      // Update bid with new carrier counter amount - store as counterAmount for admin visibility
      await storage.updateBid(bidId, { 
        amount: String(amount),
        counterAmount: String(amount), // Store carrier counter for admin to see
        status: "countered", // Mark as countered for admin review
      });

      // Create negotiation message for carrier counter
      const negotiationMessage = await storage.createBidNegotiation({
        bidId,
        loadId: bid.loadId,
        senderId: user.id,
        senderRole: "carrier",
        messageType: "counter_offer",
        message: message || `Counter offer: Rs. ${amount.toLocaleString('en-IN')}`,
        amount: String(amount),
        previousAmount: bid.counterAmount || bid.amount,
        carrierName: user.companyName || user.username,
        isSimulated: false,
      });

      // Update thread status
      await storage.updateNegotiationThread(bid.loadId, {
        status: "counter_received",
        lastActivityAt: new Date(),
      });

      // Notify admin
      const admins = await storage.getAdmins();
      for (const admin of admins) {
        await storage.createNotification({
          userId: admin.id,
          title: "Carrier Counter Offer",
          message: `${user.companyName || user.username} countered with Rs. ${amount.toLocaleString('en-IN')}`,
          type: "warning",
          relatedLoadId: bid.loadId,
          relatedBidId: bidId,
          contextType: "counter_offer",
        });
      }

      // Broadcast real-time counter event to admin for chat sync
      broadcastNegotiationMessage("admin", null, bidId, {
        ...negotiationMessage,
        senderName: user.companyName || user.username,
        loadId: bid.loadId,
        action: "carrier_counter",
      });

      // Also broadcast to carrier for confirmation
      broadcastNegotiationMessage("carrier", user.id, bidId, {
        ...negotiationMessage,
        senderName: user.companyName || user.username,
        loadId: bid.loadId,
        action: "carrier_counter_confirmed",
      });

      // Broadcast bid countered for UI updates with complete payload
      broadcastBidCountered(user.id, bid.loadId, {
        bidId,
        carrierId: user.id,
        carrierName: user.companyName || user.username,
        amount: String(amount),
        counterAmount: String(amount),
        loadId: bid.loadId,
        loadPickup: load.pickupCity,
        loadDropoff: load.dropoffCity,
      });

      res.json({ success: true, message: negotiationMessage });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Carrier counter error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Carrier accepts admin counter offer
  app.post("/api/carrier/bids/:bidId/accept", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Only carriers can accept bids" });
      }

      const { bidId } = req.params;
      const { agreedPrice } = req.body; // Price from frontend negotiation chat
      
      const bid = await storage.getBid(bidId);
      if (!bid) {
        return res.status(404).json({ error: "Bid not found" });
      }

      if (bid.carrierId !== user.id) {
        return res.status(403).json({ error: "You can only respond to your own bids" });
      }

      const load = await storage.getLoad(bid.loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      // Use agreedPrice from frontend if provided (parsed from chat history)
      // This captures informal prices mentioned in chat messages
      let finalAmount = agreedPrice;
      
      if (!finalAmount) {
        // Fallback: Get the latest counter amount from negotiation history
        const negotiations = await storage.getBidNegotiations(bidId);
        const adminOffers = negotiations
          .filter(n => n.senderRole === "admin" && n.amount)
          .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
        
        const latestAdminOffer = adminOffers[0]?.amount;
        finalAmount = latestAdminOffer || bid.counterAmount || bid.amount;
      }
      
      // Record the accepted amount before calling acceptBid workflow
      // The acceptBid workflow will update status and complete the full workflow
      await storage.updateBid(bidId, { 
        adminMediated: true,  // Flag that carrier has responded to admin counter
        counterAmount: finalAmount, // Ensure counterAmount reflects the accepted price
      });

      // Create negotiation message for acceptance
      const negotiationMessage = await storage.createBidNegotiation({
        bidId,
        loadId: bid.loadId,
        senderId: user.id,
        senderRole: "carrier",
        messageType: "carrier_accept",
        message: `Accepted counter offer of Rs. ${Number(finalAmount).toLocaleString('en-IN')}`,
        amount: finalAmount,
        previousAmount: bid.amount,
        carrierName: user.companyName || user.username,
        isSimulated: false,
      });

      // Update thread status
      await storage.updateNegotiationThread(bid.loadId, {
        status: "accepted",
        lastActivityAt: new Date(),
      });

      // Use the full acceptBid workflow from workflow-service.ts
      // This handles ALL steps: bid acceptance, rejecting other bids, load state transition, 
      // invoice creation, pickup ID generation, shipment creation, and broadcast notifications
      const acceptResult = await acceptBid(bidId, user.id, Number(finalAmount));
      
      if (!acceptResult.success) {
        console.error("Failed to accept bid via workflow:", acceptResult.error);
        return res.status(400).json({ error: acceptResult.error || "Failed to complete bid acceptance workflow" });
      }
      
      console.log(`[CarrierAccept] Workflow completed - Shipment: ${acceptResult.shipmentId?.slice(0, 8)}, Invoice: ${acceptResult.invoiceId?.slice(0, 8)}`);
      
      // Note: Shipment and invoice are now created inside acceptBid workflow
      // No need for duplicate creation here

      // Notify admin about the completed bid acceptance
      const admins = await storage.getAdmins();
      for (const admin of admins) {
        await storage.createNotification({
          userId: admin.id,
          title: "Bid Accepted - Invoice Created",
          message: `${user.companyName || user.username} accepted the counter offer of Rs. ${Number(finalAmount).toLocaleString('en-IN')} for load ${load.pickupCity} to ${load.dropoffCity}. Invoice has been generated automatically.`,
          type: "info",
          contextType: "bid_accepted",
          relatedLoadId: bid.loadId,
          relatedBidId: bidId,
        });
      }

      // Broadcast real-time acceptance to admin
      broadcastNegotiationMessage("admin", null, bidId, {
        ...negotiationMessage,
        senderName: user.companyName || user.username,
        loadId: bid.loadId,
        action: "carrier_accept",
      });

      // Also broadcast bid_accepted for carrier and admin dashboard updates
      broadcastBidAccepted(user.id, bid.loadId, {
        bidId,
        loadId: bid.loadId,
        carrierId: user.id,
        carrierName: user.companyName || user.username,
        amount: String(finalAmount),
        loadPickup: load.pickupCity,
        loadDropoff: load.dropoffCity,
      });

      // Also broadcast to carrier for confirmation
      broadcastNegotiationMessage("carrier", user.id, bidId, {
        ...negotiationMessage,
        senderName: user.companyName || user.username,
        loadId: bid.loadId,
        action: "carrier_accept_confirmed",
      });

      res.json({ success: true, message: negotiationMessage });
    } catch (error) {
      console.error("Carrier accept error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/loads/:loadId/bids", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      // Admin-as-Mediator: Shippers cannot access bids on non-finalized loads
      if (user.role === "shipper") {
        const load = await storage.getLoad(req.params.loadId);
        if (load && !["assigned", "in_transit", "delivered"].includes(load.status || "")) {
          return res.json({ 
            soloBids: [], 
            enterpriseBids: [], 
            allBids: [],
            summary: {
              totalBids: 0,
              soloBidCount: 0,
              enterpriseBidCount: 0,
              lowestSoloBid: null,
              lowestEnterpriseBid: null,
            }
          });
        }
      }

      const bidsList = await storage.getBidsByLoad(req.params.loadId);
      
      // Enrich bids with carrier details including profile and truck info
      const bidsWithCarriers = await Promise.all(
        bidsList.map(async (bid) => {
          const carrier = await storage.getUser(bid.carrierId);
          const carrierProfile = await storage.getCarrierProfile(bid.carrierId);
          const truck = bid.truckId ? await storage.getTruck(bid.truckId) : null;
          const { password: _, ...carrierWithoutPassword } = carrier || {};
          
          // Determine carrier type from bid or profile
          const carrierType = bid.carrierType || carrierProfile?.carrierType || "enterprise";
          
          return { 
            ...bid, 
            carrierType,
            carrier: carrierWithoutPassword,
            carrierProfile: carrierProfile ? {
              fleetSize: carrierProfile.fleetSize,
              carrierType: carrierProfile.carrierType,
              operatingRegion: carrierProfile.operatingRegion,
              verificationStatus: (carrierProfile as any).verificationStatus,
            } : null,
            truck: truck ? {
              id: truck.id,
              registrationNumber: truck.registrationNumber,
              manufacturer: (truck as any).manufacturer || truck.make,
              model: truck.model,
              capacity: truck.capacity,
              truckType: truck.truckType,
            } : null,
          };
        })
      );

      // Group bids by carrier type for admin dual marketplace view
      const soloBids = bidsWithCarriers.filter(b => b.carrierType === "solo");
      const enterpriseBids = bidsWithCarriers.filter(b => b.carrierType === "enterprise");

      // Safely calculate lowest bids - handle numeric or string amounts
      const getLowestBid = (bids: typeof bidsWithCarriers) => {
        if (bids.length === 0) return null;
        const amounts = bids.map(b => {
          const amt = b.amount;
          if (amt === null || amt === undefined) return Infinity;
          return typeof amt === 'number' ? amt : parseFloat(String(amt));
        }).filter(a => !isNaN(a) && a !== Infinity);
        return amounts.length > 0 ? Math.min(...amounts) : null;
      };

      res.json({
        soloBids,
        enterpriseBids,
        allBids: bidsWithCarriers,
        summary: {
          totalBids: bidsWithCarriers.length,
          soloBidCount: soloBids.length,
          enterpriseBidCount: enterpriseBids.length,
          lowestSoloBid: getLowestBid(soloBids),
          lowestEnterpriseBid: getLowestBid(enterpriseBids),
        }
      });
    } catch (error) {
      console.error("Get load bids error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/bids", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Only carriers can place bids" });
      }

      // Check document compliance before allowing bid placement
      const compliance = await checkCarrierDocumentCompliance(user.id);
      if (!compliance.compliant) {
        return res.status(403).json({ 
          error: "Document compliance issue",
          message: compliance.reason,
          expiredDocuments: compliance.expiredDocuments,
          action: "Please renew expired documents before placing bids"
        });
      }

      // Determine carrier type from profile
      const carrierProfile = await storage.getCarrierProfile(user.id);
      const carrierType = carrierProfile?.carrierType || "enterprise";
      
      // Fleet carrier restriction: truck and driver can only be assigned to one active load at a time
      const isFleetCarrier = carrierType === 'enterprise' || carrierType === 'fleet';
      if (isFleetCarrier && (req.body.truckId || req.body.driverId)) {
        // Comprehensive list of active/non-terminal shipment statuses
        const terminalStatuses = ['delivered', 'closed', 'cancelled', 'completed'];
        const carrierShipments = await storage.getShipmentsByCarrier(user.id);
        
        if (req.body.truckId) {
          // Check if truck is used in any non-terminal shipment
          const truckInUse = carrierShipments.find(s => 
            s.truckId === req.body.truckId && 
            !terminalStatuses.includes(s.status || '')
          );
          if (truckInUse) {
            const activeLoad = await storage.getLoad(truckInUse.loadId);
            return res.status(400).json({ 
              error: `This truck is already assigned to an active shipment (${activeLoad?.pickupCity || 'Unknown'} to ${activeLoad?.dropoffCity || 'Unknown'}). Please wait until delivery is completed.`
            });
          }
          
          // Also check accepted/awarded bids that haven't created shipments yet
          const allBids = await storage.getBidsByCarrier(user.id);
          let truckBidInProgress = null;
          for (const b of allBids) {
            if (b.truckId === req.body.truckId && b.status === 'accepted') {
              // Check if the load is still active (not delivered/completed)
              const bidLoad = await storage.getLoad(b.loadId);
              if (bidLoad && !terminalStatuses.includes(bidLoad.status || '')) {
                truckBidInProgress = b;
                break;
              }
            }
          }
          if (truckBidInProgress) {
            const activeLoad = await storage.getLoad(truckBidInProgress.loadId);
            return res.status(400).json({ 
              error: `This truck is already assigned to an accepted bid (${activeLoad?.pickupCity || 'Unknown'} to ${activeLoad?.dropoffCity || 'Unknown'}). Please wait until delivery is completed.`
            });
          }
        }
        
        if (req.body.driverId && req.body.driverId !== 'unassigned') {
          // Check if driver is used in any non-terminal shipment
          const driverInUse = carrierShipments.find(s => 
            s.driverId === req.body.driverId && 
            !terminalStatuses.includes(s.status || '')
          );
          if (driverInUse) {
            const activeLoad = await storage.getLoad(driverInUse.loadId);
            return res.status(400).json({ 
              error: `This driver is already assigned to an active shipment (${activeLoad?.pickupCity || 'Unknown'} to ${activeLoad?.dropoffCity || 'Unknown'}). Please wait until delivery is completed.`
            });
          }
          
          // Also check accepted bids for driver
          const allDriverBids = await storage.getBidsByCarrier(user.id);
          let driverBidInProgress = null;
          for (const b of allDriverBids) {
            if (b.driverId === req.body.driverId && b.status === 'accepted') {
              // Check if the load is still active (not delivered/completed)
              const bidLoad = await storage.getLoad(b.loadId);
              if (bidLoad && !terminalStatuses.includes(bidLoad.status || '')) {
                driverBidInProgress = b;
                break;
              }
            }
          }
          if (driverBidInProgress) {
            const activeLoad = await storage.getLoad(driverBidInProgress.loadId);
            return res.status(400).json({ 
              error: `This driver is already assigned to an accepted bid (${activeLoad?.pickupCity || 'Unknown'} to ${activeLoad?.dropoffCity || 'Unknown'}). Please wait until delivery is completed.`
            });
          }
        }
      }

      const data = insertBidSchema.parse({
        ...req.body,
        carrierId: user.id,
        carrierType: carrierType, // Set carrier type on bid
      });

      const bid = await storage.createBid(data);
      
      const load = await storage.getLoad(data.loadId);
      if (load && load.status === "posted") {
        await storage.updateLoad(data.loadId, { status: "bidding" });
      }

      res.json(bid);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Create bid error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.patch("/api/bids/:id", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const { action, status, reason, counterAmount, notes, finalPrice } = req.body;

      // Use workflow service for bid acceptance (auto-closes other bids + awards load)
      if (action === "accept" || status === "accepted") {
        if (user.role !== "admin") {
          return res.status(403).json({ error: "Only admin can accept bids" });
        }
        // Pass the final negotiated price if provided (from counter-offer negotiations)
        const result = await acceptBid(req.params.id, user.id, finalPrice);
        if (!result.success) {
          return res.status(400).json({ error: result.error });
        }
        return res.json(result.bid);
      }

      // Use workflow service for bid rejection
      if (action === "reject" || status === "rejected") {
        if (user.role !== "admin") {
          return res.status(403).json({ error: "Only admin can reject bids" });
        }
        const result = await rejectBid(req.params.id, user.id, reason);
        if (!result.success) {
          return res.status(400).json({ error: result.error });
        }
        return res.json(result.bid);
      }

      // Handle counter offer from admin
      if (action === "counter") {
        if (user.role !== "admin") {
          return res.status(403).json({ error: "Only admin can counter bids" });
        }
        const bid = await storage.getBid(req.params.id);
        if (!bid) {
          return res.status(404).json({ error: "Bid not found" });
        }
        
        // Update bid with counter offer
        const updatedBid = await storage.updateBid(req.params.id, {
          status: "countered",
          counterAmount: counterAmount,
          notes: notes || `Admin counter: Rs. ${Number(counterAmount).toLocaleString('en-IN')}`,
        });
        
        // Update load state to counter_received (negotiation active)
        if (bid.loadId) {
          await storage.updateLoad(bid.loadId, { 
            status: "counter_received",
            statusNote: `Admin countered with Rs. ${Number(counterAmount).toLocaleString('en-IN')}`
          });
        }
        
        // Create notification for carrier
        await storage.createNotification({
          userId: bid.carrierId,
          title: "Counter Offer Received",
          message: `Admin has countered your bid with Rs. ${Number(counterAmount).toLocaleString('en-IN')}`,
          type: "warning",
          relatedLoadId: bid.loadId,
          contextType: "counter_offer",
        });
        
        // Broadcast real-time counter event to carrier portal
        broadcastBidCountered(bid.carrierId, bid.loadId, {
          bidId: req.params.id,
          counterAmount: counterAmount,
          notes: notes,
          timestamp: new Date().toISOString(),
        });
        
        return res.json(updatedBid);
      }

      // For other updates, use storage directly
      const bid = await storage.updateBid(req.params.id, req.body);
      res.json(bid);
    } catch (error) {
      console.error("Update bid error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/shipments", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const shipmentsList = await storage.getShipmentsByCarrier(user.id);
      const enriched = await Promise.all(
        shipmentsList.map(async (s) => {
          const load = await storage.getLoad(s.loadId);
          return {
            ...s,
            load: load ? {
              pickupCity: load.pickupCity,
              pickupAddress: load.pickupAddress,
              dropoffCity: load.dropoffCity,
              dropoffAddress: load.dropoffAddress,
              weight: load.weight,
              finalPrice: load.finalPrice,
              pickupDate: load.pickupDate,
              deliveryDate: load.deliveryDate,
            } : undefined,
          };
        })
      );
      res.json(enriched);
    } catch (error) {
      console.error("Get shipments error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/notifications", requireAuth, async (req, res) => {
    try {
      const notificationsList = await storage.getNotificationsByUser(req.session.userId!);
      res.json(notificationsList);
    } catch (error) {
      console.error("Get notifications error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.patch("/api/notifications/:id/read", requireAuth, async (req, res) => {
    try {
      await storage.markNotificationAsRead(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Mark notification read error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/notifications/read-all", requireAuth, async (req, res) => {
    try {
      await storage.markAllNotificationsAsRead(req.session.userId!);
      res.json({ success: true });
    } catch (error) {
      console.error("Mark all notifications read error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/documents", requireAuth, async (req, res) => {
    try {
      const documentsList = await storage.getDocumentsByUser(req.session.userId!);
      res.json(documentsList);
    } catch (error) {
      console.error("Get documents error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/users", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }
      const usersList = await storage.getAllUsers();
      const usersWithoutPasswords = usersList.map(({ password: _, ...u }) => u);
      res.json(usersWithoutPasswords);
    } catch (error) {
      console.error("Get users error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/carriers", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required - Shippers cannot view carrier directory" });
      }

      const allUsers = await storage.getAllUsers();
      const carriers = allUsers.filter(u => u.role === "carrier");
      
      const carriersWithProfiles = await Promise.all(
        carriers.map(async (carrier) => {
          const profile = await storage.getCarrierProfile(carrier.id);
          const verification = await storage.getCarrierVerificationByCarrier(carrier.id);
          const { password: _, ...carrierWithoutPassword } = carrier;
          
          // Add verificationStatus to profile for dashboard filtering
          const profileWithVerification = profile ? {
            ...profile,
            verificationStatus: verification?.status || 'pending'
          } : {
            verificationStatus: verification?.status || 'pending'
          };
          
          return { 
            ...carrierWithoutPassword, 
            carrierProfile: profileWithVerification 
          };
        })
      );

      res.json(carriersWithProfiles);
    } catch (error) {
      console.error("Get carriers error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/messages/:loadId", requireAuth, async (req, res) => {
    try {
      const messagesList = await storage.getMessagesByLoad(req.params.loadId);
      res.json(messagesList);
    } catch (error) {
      console.error("Get messages error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/messages", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const message = await storage.createMessage({
        ...req.body,
        senderId: user.id,
      });

      res.json(message);
    } catch (error) {
      console.error("Create message error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin routes
  const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const user = await storage.getUser(req.session.userId);
    if (!user || user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }
    next();
  };

  // Admin: Get platform stats
  app.get("/api/admin/stats", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      // Run both queries in parallel for better performance
      const [allUsers, allLoads] = await Promise.all([
        storage.getAllUsers(),
        storage.getAllLoads(),
      ]);
      
      const carriers = allUsers.filter(u => u.role === "carrier");
      const verifiedCarriers = carriers.filter(u => u.isVerified);

      const activeLoads = allLoads.filter(l => 
        ["posted", "bidding", "assigned", "in_transit"].includes(l.status || "")
      );

      const deliveredLoads = allLoads.filter(l => l.status === "delivered");
      const totalVolume = deliveredLoads.reduce((sum, l) => 
        sum + parseFloat(l.finalPrice?.toString() || l.estimatedPrice?.toString() || "0"), 0
      );

      res.json({
        totalUsers: allUsers.length,
        totalShippers: allUsers.filter(u => u.role === "shipper").length,
        totalCarriers: carriers.length,
        verifiedCarriers: verifiedCarriers.length,
        activeLoads: activeLoads.length,
        completedLoads: deliveredLoads.length,
        totalLoads: allLoads.length,
        monthlyVolume: totalVolume,
      });
    } catch (error) {
      console.error("Get admin stats error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/live-tracking - Get all active shipments with full details for admin tracking
  app.get("/api/admin/live-tracking", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      // Get all shipments - show all shipments with pickup dates
      const allShipments = await storage.getAllShipments();

      // Enrich each shipment with full details
      const enrichedShipments = await Promise.all(
        allShipments.map(async (shipment) => {
          const load = await storage.getLoad(shipment.loadId);
          const shipper = load ? await storage.getUser(load.shipperId) : null;
          const carrier = await storage.getUser(shipment.carrierId);
          const carrierProfile = carrier ? await storage.getCarrierProfile(carrier.id) : null;
          
          // Get truck
          let truck = null;
          if (shipment.truckId) {
            truck = await storage.getTruck(shipment.truckId);
          } else if (load?.assignedTruckId) {
            truck = await storage.getTruck(load.assignedTruckId);
          } else if (load?.awardedBidId) {
            const bid = await storage.getBid(load.awardedBidId);
            if (bid?.truckId) {
              truck = await storage.getTruck(bid.truckId);
            }
          }
          if (!truck && carrier) {
            const carrierTrucks = await storage.getTrucksByCarrier(carrier.id);
            if (carrierTrucks.length > 0) {
              truck = carrierTrucks[0];
            }
          }
          
          // Get driver info
          const carrierType = carrierProfile?.carrierType || 'solo';
          let driverInfo: { name: string; phone: string | null } | null = null;
          
          if (carrierType === 'solo') {
            driverInfo = {
              name: carrier?.username || 'Unknown',
              phone: carrier?.phone || null,
            };
          } else if (shipment.driverId) {
            const driver = await storage.getDriver(shipment.driverId);
            if (driver) {
              driverInfo = {
                name: driver.name,
                phone: driver.phone || null,
              };
            }
          }
          
          // Calculate progress
          let progress = 0;
          let currentStage = "pickup_scheduled";
          
          if (shipment.endOtpVerified) {
            progress = 100;
            currentStage = "delivered";
          } else if (shipment.startOtpVerified) {
            progress = 60;
            currentStage = "in_transit";
          } else if (shipment.startOtpRequested) {
            progress = 40;
            currentStage = "at_pickup";
          } else {
            progress = 20;
            currentStage = "pickup_scheduled";
          }

          return {
            id: shipment.id,
            loadId: shipment.loadId,
            status: shipment.status,
            progress,
            currentStage,
            createdAt: shipment.createdAt,
            startedAt: shipment.startedAt,
            eta: shipment.eta,
            currentLocation: {
              lat: shipment.currentLat ? parseFloat(shipment.currentLat.toString()) : null,
              lng: shipment.currentLng ? parseFloat(shipment.currentLng.toString()) : null,
              address: shipment.currentLocation,
            },
            otp: {
              startRequested: shipment.startOtpRequested,
              startVerified: shipment.startOtpVerified,
              endRequested: shipment.endOtpRequested,
              endVerified: shipment.endOtpVerified,
            },
            load: load ? {
              id: load.id,
              referenceNumber: load.shipperLoadNumber || load.adminReferenceNumber,
              pickupCity: load.pickupCity,
              pickupAddress: load.pickupAddress,
              pickupState: load.pickupLocality,
              dropoffCity: load.dropoffCity,
              dropoffAddress: load.dropoffAddress,
              dropoffState: load.dropoffLocality,
              materialType: load.materialType,
              weight: load.weight,
              requiredTruckType: load.requiredTruckType,
              pickupDate: load.pickupDate,
              deliveryDate: load.deliveryDate,
            } : null,
            shipper: shipper ? {
              id: shipper.id,
              username: shipper.username,
              companyName: load?.shipperCompanyName || shipper.companyName || shipper.username,
              contactName: load?.shipperContactName || shipper.username,
              phone: load?.shipperPhone || shipper.phone,
              email: shipper.email,
              address: load?.shipperCompanyAddress,
            } : null,
            receiver: load ? {
              name: load.receiverName,
              phone: load.receiverPhone,
              email: load.receiverEmail,
              businessName: load.dropoffBusinessName,
              address: load.dropoffAddress,
              city: load.dropoffCity,
            } : null,
            carrier: carrier ? {
              id: carrier.id,
              username: carrier.username,
              companyName: carrierProfile?.companyName || carrier.companyName || carrier.username,
              phone: carrier.phone,
              carrierType: carrierType,
            } : null,
            driver: driverInfo,
            truck: truck ? {
              id: truck.id,
              registrationNumber: truck.licensePlate,
              truckType: truck.truckType,
              capacity: truck.capacity,
            } : null,
            timeline: [
              {
                stage: "load_created",
                completed: true,
                timestamp: load?.createdAt || shipment.createdAt,
                location: load?.pickupCity || "Origin",
              },
              {
                stage: "carrier_assigned",
                completed: true,
                timestamp: shipment.createdAt,
                location: load?.pickupCity || "Origin",
              },
              {
                stage: "reached_pickup",
                completed: !!(shipment.startOtpRequestedAt || shipment.startOtpRequested),
                timestamp: shipment.startOtpRequestedAt || null,
                location: load?.pickupCity || "Pickup Location",
              },
              {
                stage: "loaded",
                completed: !!(shipment.startOtpVerifiedAt || shipment.startOtpVerified),
                timestamp: shipment.startOtpVerifiedAt || null,
                location: load?.pickupCity || "Pickup Location",
              },
              {
                stage: "in_transit",
                completed: !!(shipment.startedAt || shipment.startOtpVerified),
                timestamp: shipment.startedAt || shipment.startOtpVerifiedAt || null,
                location: "En Route",
              },
              {
                stage: "arrived_at_drop",
                completed: !!(shipment.endOtpRequestedAt || shipment.endOtpRequested),
                timestamp: shipment.endOtpRequestedAt || null,
                location: load?.dropoffCity || "Delivery Location",
              },
              {
                stage: "delivered",
                completed: !!(shipment.completedAt || shipment.endOtpVerified),
                timestamp: shipment.completedAt || shipment.endOtpVerifiedAt || null,
                location: load?.dropoffCity || "Delivered",
              },
            ],
            documents: (await storage.getDocumentsByShipment(shipment.id)).map(doc => ({
              id: doc.id,
              documentType: doc.documentType,
              fileName: doc.fileName,
              fileUrl: doc.fileUrl,
              fileSize: doc.fileSize,
              isVerified: doc.isVerified,
              createdAt: doc.createdAt,
            })),
            financeReview: await (async () => {
              const review = await storage.getFinanceReviewByShipment(shipment.id);
              if (!review) return null;
              const reviewer = await storage.getUser(review.reviewerId);
              return {
                id: review.id,
                status: review.status,
                comment: review.comment,
                paymentStatus: review.paymentStatus,
                reviewedAt: review.reviewedAt,
                reviewerName: reviewer?.username || "Unknown",
              };
            })(),
          };
        })
      );

      res.json(enrichedShipments);
    } catch (error) {
      console.error("Get admin live tracking error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get admin contact info (for carriers to call)
  app.get("/api/admin/contact", requireAuth, async (req, res) => {
    try {
      const admins = await storage.getAdmins();
      if (admins.length === 0) {
        return res.status(404).json({ error: "No admin found" });
      }
      // Return first admin's contact info
      const admin = admins[0];
      res.json({
        phone: admin.phone || null,
        email: admin.email || null,
        name: (admin as any).companyName || admin.username || "Load Smart Admin",
      });
    } catch (error) {
      console.error("Get admin contact error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin: Update user
  app.patch("/api/admin/users/:id", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const updated = await storage.updateUser(req.params.id, req.body);
      if (!updated) {
        return res.status(404).json({ error: "User not found" });
      }

      const { password: _, ...userWithoutPassword } = updated;
      res.json(userWithoutPassword);
    } catch (error) {
      console.error("Update user error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin: Get all users
  app.get("/api/admin/users", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const allUsers = await storage.getAllUsers();
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const carrierProfilesData = await db.select().from(carrierProfilesTable);
      const carrierTypeMap = new Map(carrierProfilesData.map(cp => [cp.userId, cp.carrierType]));

      const onboardingData = await db.select({
        shipperId: shipperOnboardingRequests.shipperId,
        shipperRole: shipperOnboardingRequests.shipperRole,
      }).from(shipperOnboardingRequests);
      const shipperRoleMap = new Map(onboardingData.map(o => [o.shipperId, o.shipperRole]));
      
      const usersWithoutPasswords = allUsers.map(u => {
        const { password: _, ...userWithoutPassword } = u;
        
        let status = "pending";
        if (u.isVerified) {
          const lastActive = u.lastActiveAt ? new Date(u.lastActiveAt) : (u.createdAt ? new Date(u.createdAt) : new Date());
          status = lastActive < thirtyDaysAgo ? "inactive" : "active";
        }

        const carrierType = u.role === "carrier" ? (carrierTypeMap.get(u.id) || null) : null;
        const shipperRole = u.role === "shipper" ? (shipperRoleMap.get(u.id) || null) : null;
        
        return {
          ...userWithoutPassword,
          userNumber: u.userNumber,
          displayUserId: u.userNumber ? `USR-${String(u.userNumber).padStart(3, '0')}` : null,
          name: u.username,
          company: u.companyName || "",
          dateJoined: u.createdAt,
          phone: u.phone || "",
          status,
          region: "India",
          carrierType,
          shipperRole,
        };
      });

      const showAll = req.query.showAll === "true";
      const filtered = showAll ? usersWithoutPasswords : usersWithoutPasswords.filter(u => u.isVerified);

      res.json(filtered);
    } catch (error) {
      console.error("Get all users error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin: Create user (for admin to add users manually)
  app.post("/api/admin/users", requireAuth, async (req, res) => {
    try {
      const adminUser = await storage.getUser(req.session.userId!);
      if (!adminUser || adminUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const data = insertUserSchema.parse(req.body);
      const hashedPassword = await hashPassword(data.password);
      const newUser = await storage.createUser({
        ...data,
        password: hashedPassword,
      });

      if (newUser.role === "carrier") {
        await storage.createCarrierProfile({
          userId: newUser.id,
          fleetSize: 1,
          serviceZones: [],
          reliabilityScore: "0",
          communicationScore: "0",
          onTimeScore: "0",
          totalDeliveries: 0,
          badgeLevel: "bronze",
          bio: null,
        });
      }

      const { password: _, ...userWithoutPassword } = newUser;
      res.json(userWithoutPassword);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Admin create user error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin: Get all loads with shipper info
  app.get("/api/admin/loads", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const allLoads = await storage.getAllLoads();
      
      const loadsWithDetails = await Promise.all(
        allLoads.map(async (load) => {
          const shipper = await storage.getUser(load.shipperId);
          const carrier = load.assignedCarrierId ? await storage.getUser(load.assignedCarrierId) : null;
          const loadBids = await storage.getBidsByLoad(load.id);
          
          return {
            ...load,
            shipper: shipper ? { username: shipper.username, companyName: shipper.companyName } : null,
            carrier: carrier ? { username: carrier.username, companyName: carrier.companyName } : null,
            bidCount: loadBids.length,
          };
        })
      );

      res.json(loadsWithDetails);
    } catch (error) {
      console.error("Get admin loads error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin: Create load
  app.post("/api/admin/loads", requireAuth, async (req, res) => {
    try {
      const adminUser = await storage.getUser(req.session.userId!);
      if (!adminUser || adminUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      // Get next sequential global load number
      const shipperLoadNumber = await storage.getNextGlobalLoadNumber();
      
      const data = insertLoadSchema.parse({
        ...req.body,
        shipperLoadNumber,
      });
      const load = await storage.createLoad(data);
      res.json(load);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Admin create load error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin: Update load (with carrier assignment)
  app.patch("/api/admin/loads/:id", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const updated = await storage.updateLoad(req.params.id, req.body);
      
      // Broadcast admin edit to shipper portal for real-time sync
      if (updated) {
        broadcastLoadUpdated(updated.id, updated.shipperId, updated.status, "admin_edited", {
          id: updated.id,
          status: updated.status,
          pickupCity: updated.pickupCity,
          dropoffCity: updated.dropoffCity,
          weight: updated.weight,
          materialType: updated.materialType,
          pickupDate: updated.pickupDate,
          deliveryDate: updated.deliveryDate,
          adminFinalPrice: updated.adminFinalPrice,
          rateType: updated.rateType,
        });
      }
      
      res.json(updated);
    } catch (error) {
      console.error("Admin update load error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin: Get verified shippers for load creation
  app.get("/api/admin/shippers/verified", requireAuth, async (req, res) => {
    try {
      const adminUser = await storage.getUser(req.session.userId!);
      if (!adminUser || adminUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      // Query only verified shippers from database
      const verifiedShippers = await db.select({
        id: users.id,
        username: users.username,
        email: users.email,
        companyName: users.companyName,
        companyAddress: users.companyAddress,
        phone: users.phone,
        isVerified: users.isVerified,
      }).from(users).where(and(
        eq(users.role, 'shipper'),
        eq(users.isVerified, true)
      ));
      
      res.json(verifiedShippers);
    } catch (error) {
      console.error("Error fetching shippers:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin: Create and optionally price/post a load (mirrors shipper post-load)
  app.post("/api/admin/loads/create", requireAuth, async (req, res) => {
    try {
      const adminUser = await storage.getUser(req.session.userId!);
      if (!adminUser || adminUser.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const body = { ...req.body };
      
      // Validate required fields
      if (!body.shipperCompanyName || !body.pickupCity || !body.dropoffCity || !body.weight || !body.pickupDate) {
        return res.status(400).json({ error: "Missing required fields: shipperCompanyName, pickupCity, dropoffCity, weight, pickupDate" });
      }
      
      // Validate postImmediately requires adminGrossPrice
      if (body.postImmediately && !body.adminGrossPrice) {
        return res.status(400).json({ error: "adminGrossPrice is required when postImmediately is true" });
      }
      
      // Parse dates if they're strings
      if (body.pickupDate && typeof body.pickupDate === 'string') {
        body.pickupDate = new Date(body.pickupDate);
      }
      if (body.deliveryDate && typeof body.deliveryDate === 'string') {
        body.deliveryDate = new Date(body.deliveryDate);
      }
      if (typeof body.weight === 'string') {
        const parsed = parseFloat(body.weight);
        body.weight = (!body.weight || isNaN(parsed)) ? null : parsed;
      }

      // Get next sequential global load number
      const shipperLoadNumber = await storage.getNextGlobalLoadNumber();
      
      // Determine shipperId - use existingShipperId if provided, otherwise auto-create new shipper
      let shipperId = adminUser.id;
      let newShipperCreated = false;
      
      if (body.existingShipperId) {
        // Use existing shipper
        const existingShipper = await storage.getUser(body.existingShipperId);
        if (existingShipper && existingShipper.role === 'shipper') {
          shipperId = existingShipper.id;
        }
      } else if (body.shipperContactName && body.shipperPhone) {
        // Auto-create new shipper account when entering manual details
        // Normalize phone number for consistent lookup (remove non-digits, keep last 10)
        const rawPhone = body.shipperPhone;
        const normalizedPhone = rawPhone.replace(/\D/g, '').slice(-10);
        
        // Generate a guaranteed unique email using timestamp + phone (ignore user-supplied email for auto-create)
        const timestamp = Date.now();
        const shipperEmail = `shipper_${normalizedPhone}_${timestamp}@loadsmart.auto`;
        
        // Check if user with this phone already exists
        // Try multiple formats: normalized, raw input, with +91 prefix (Indian phones)
        let existingByPhone = await storage.getUserByPhone(normalizedPhone);
        if (!existingByPhone && rawPhone !== normalizedPhone) {
          existingByPhone = await storage.getUserByPhone(rawPhone);
        }
        if (!existingByPhone) {
          existingByPhone = await storage.getUserByPhone(`+91${normalizedPhone}`);
        }
        if (existingByPhone) {
          if (existingByPhone.role === 'shipper') {
            // Use existing shipper
            shipperId = existingByPhone.id;
          } else {
            // Existing user with same phone is not a shipper (carrier/admin)
            // Return error - cannot auto-create shipper with conflicting phone
            return res.status(400).json({ 
              error: `Phone number ${body.shipperPhone} is already registered to a ${existingByPhone.role} account. Please use a different phone number or select an existing shipper.` 
            });
          }
        } else {
          // Create new shipper user (auto-verified since admin is creating)
          // Generate random password and hash it properly
          const randomPassword = crypto.randomUUID();
          const hashedPassword = await hashPassword(randomPassword);
          
          const newShipperUser = await storage.createUser({
            username: body.shipperContactName,
            email: shipperEmail,
            password: hashedPassword,
            role: 'shipper',
            phone: normalizedPhone, // Store normalized phone
            companyName: body.shipperCompanyName || null,
            isVerified: true, // Auto-verify since admin is creating
          });
          
          shipperId = newShipperUser.id;
          newShipperCreated = true;
          
          // Create shipper onboarding record (auto-approved)
          const onboardingReq = await storage.createShipperOnboardingRequest({
            shipperId: newShipperUser.id,
            legalCompanyName: body.shipperCompanyName || body.shipperContactName,
            businessType: 'manufacturer',
            contactPersonName: body.shipperContactName,
            contactPersonPhone: normalizedPhone, // Store normalized phone
            contactPersonEmail: shipperEmail,
            registeredAddress: body.shipperCompanyAddress || 'N/A',
            status: 'approved',
            decisionNote: 'Auto-created by admin via Post a Load',
          });

          // Update with admin review details (omitted from create schema)
          await storage.updateShipperOnboardingRequest(onboardingReq.id, {
            reviewedAt: new Date(),
            reviewedBy: adminUser.id,
          });
        }
      }
      
      // Create the load with pending status (to go to queue) or priced if posting immediately
      const status = body.postImmediately && body.adminGrossPrice ? 'posted_to_carriers' : 'pending';
      
      const loadData = insertLoadSchema.parse({
        shipperId,
        shipperLoadNumber,
        status,
        shipperCompanyName: body.shipperCompanyName,
        shipperContactName: body.shipperContactName || 'N/A',
        shipperCompanyAddress: body.shipperCompanyAddress || 'N/A',
        shipperPhone: body.shipperPhone || 'N/A',
        pickupAddress: body.pickupAddress || body.pickupCity,
        pickupLocality: body.pickupLocality || null,
        pickupLandmark: body.pickupLandmark || null,
        pickupBusinessName: body.pickupBusinessName || null,
        pickupCity: body.pickupCity,
        pickupState: body.pickupState || null,
        dropoffAddress: body.dropoffAddress || body.dropoffCity,
        dropoffLocality: body.dropoffLocality || null,
        dropoffLandmark: body.dropoffLandmark || null,
        dropoffBusinessName: body.dropoffBusinessName || null,
        dropoffCity: body.dropoffCity,
        dropoffState: body.dropoffState || null,
        receiverName: body.receiverName || null,
        receiverPhone: body.receiverPhone || null,
        receiverEmail: body.receiverEmail || null,
        weight: body.weight,
        materialType: body.goodsToBeCarried || 'General Cargo',
        specialNotes: body.specialNotes || null,
        rateType: body.rateType || 'fixed_price',
        shipperPricePerTon: body.shipperPricePerTon ? String(body.shipperPricePerTon) : null,
        shipperFixedPrice: body.shipperFixedPrice ? String(body.shipperFixedPrice) : null,
        advancePaymentPercent: body.advancePaymentPercent || null,
        requiredTruckType: body.requiredTruckType || 'open_body',
        pickupDate: body.pickupDate,
        deliveryDate: body.deliveryDate || null,
        submittedAt: new Date(),
        adminFinalPrice: body.postImmediately && body.adminGrossPrice ? String(body.adminGrossPrice) : null,
        postedAt: body.postImmediately ? new Date() : null,
        // Admin employee info (who filled the form)
        adminEmployeeCode: body.adminEmployeeCode || null,
        adminEmployeeName: body.adminEmployeeName || null,
      });

      const load = await storage.createLoad(loadData);

      // If posting immediately, create admin decision record
      if (body.postImmediately && body.adminGrossPrice) {
        await storage.createAdminDecision({
          loadId: load.id,
          adminId: adminUser.id,
          suggestedPrice: String(body.adminGrossPrice),
          finalPrice: String(body.adminGrossPrice),
          postingMode: 'open_market',
          invitedCarrierIds: null,
          comment: 'Posted by admin via Post a Load',
          pricingBreakdown: {
            grossPrice: body.adminGrossPrice,
            platformMargin: body.platformMargin || '10',
            carrierAdvance: body.carrierAdvancePercent || '30',
          },
          actionType: 'price_and_post',
        });

        // Broadcast to marketplace
        broadcastMarketplaceEvent(
          'load_posted',
          {
            loadId: load.id,
            data: {
              id: load.id,
              pickupCity: load.pickupCity,
              dropoffCity: load.dropoffCity,
              weight: load.weight,
              materialType: load.materialType,
              price: parseInt(body.adminGrossPrice),
              pickupDate: load.pickupDate,
            }
          }
        );
      }

      res.json({ 
        load_id: load.id, 
        load_number: load.shipperLoadNumber, 
        status: load.status,
        posted: body.postImmediately && body.adminGrossPrice ? true : false,
        shipper_id: shipperId,
        new_shipper_created: newShipperCreated,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Admin create load error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin: Get carriers with profiles
  app.get("/api/admin/carriers", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const allUsers = await storage.getAllUsers();
      const carriers = allUsers.filter(u => u.role === "carrier");
      
      const carriersWithDetails = await Promise.all(
        carriers.map(async (carrier) => {
          const profile = await storage.getCarrierProfile(carrier.id);
          const carrierBids = await storage.getBidsByCarrier(carrier.id);
          const documents = await storage.getDocumentsByUser(carrier.id);
          
          const { password: _, ...carrierWithoutPassword } = carrier;
          return {
            ...carrierWithoutPassword,
            profile,
            bidCount: carrierBids.length,
            documentCount: documents.length,
          };
        })
      );

      res.json(carriersWithDetails);
    } catch (error) {
      console.error("Get admin carriers error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin: Get single carrier with full details
  app.get("/api/admin/carriers/:id", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const carrier = await storage.getUser(req.params.id);
      if (!carrier || carrier.role !== "carrier") {
        return res.status(404).json({ error: "Carrier not found" });
      }

      const profile = await storage.getCarrierProfile(carrier.id);
      const carrierBids = await storage.getBidsByCarrier(carrier.id);
      const documents = await storage.getDocumentsByUser(carrier.id);
      const trucks = await storage.getTrucksByCarrier(carrier.id);
      const verification = await storage.getCarrierVerificationByCarrier(carrier.id);
      
      // Get loads where this carrier has bids
      const allLoads = await storage.getAllLoads();
      const carrierLoads = allLoads.filter(load => 
        carrierBids.some(bid => bid.loadId === load.id)
      );

      // Extract truck documents from trucks and format them for display
      const truckDocuments: any[] = [];
      const parseDocUrl = (urlJson: any) => {
        if (!urlJson) return null;
        try {
          if (typeof urlJson === 'string') {
            const parsed = JSON.parse(urlJson);
            return { path: parsed.path, name: parsed.name };
          }
          return urlJson;
        } catch { return null; }
      };
      
      for (const truck of trucks) {
        const docTypes = [
          { field: 'rcDocumentUrl', type: 'truck_rc', label: 'Registration Certificate', expiry: null, verifiedField: 'rcVerified' },
          { field: 'insuranceDocumentUrl', type: 'truck_insurance', label: 'Insurance Certificate', expiry: truck.insuranceExpiry, verifiedField: 'insuranceVerified' },
          { field: 'fitnessDocumentUrl', type: 'truck_fitness', label: 'Fitness Certificate', expiry: truck.fitnessExpiry, verifiedField: 'fitnessVerified' },
          { field: 'permitDocumentUrl', type: 'truck_permit', label: 'Permit', expiry: (truck as any).permitExpiry, verifiedField: 'permitVerified' },
          { field: 'pucDocumentUrl', type: 'truck_puc', label: 'PUC Certificate', expiry: (truck as any).pucExpiry, verifiedField: 'pucVerified' },
        ];
        
        for (const docType of docTypes) {
          const docData = parseDocUrl((truck as any)[docType.field]);
          if (docData) {
            // Get verification status from truck record
            const isVerified = (truck as any)[docType.verifiedField] === true;
            truckDocuments.push({
              id: `${truck.id}-${docType.type}`,
              userId: carrier.id,
              documentType: docType.type,
              fileName: docData.name || `${docType.label}`,
              fileUrl: docData.path,
              expiryDate: docType.expiry,
              isVerified: isVerified,
              createdAt: truck.createdAt || new Date(),
              truckId: truck.id,
              truckPlate: truck.licensePlate,
              source: 'truck',
            });
          }
        }
      }
      
      // Combine shipment documents with truck documents
      const allDocuments = [...documents, ...truckDocuments];

      const { password: _, ...carrierWithoutPassword } = carrier;
      
      res.json({
        ...carrierWithoutPassword,
        profile: profile || {
          userId: carrier.id,
          carrierType: "enterprise",
          fleetSize: trucks.length || 1,
          serviceZones: [],
          reliabilityScore: "0.00",
          communicationScore: "0.00",
          onTimeScore: "0.00",
          totalDeliveries: 0,
          badgeLevel: "bronze",
          rating: "4.5",
        },
        bids: carrierBids,
        bidCount: carrierBids.length,
        documents: allDocuments,
        documentCount: allDocuments.length,
        trucks,
        truckCount: trucks.length,
        verification,
        assignedLoads: carrierLoads.slice(0, 20), // Limit to 20 recent loads
      });
    } catch (error) {
      console.error("Get admin carrier error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin: Verify/unverify carrier
  app.patch("/api/admin/carriers/:id/verify", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { isVerified } = req.body;
      const updated = await storage.updateUser(req.params.id, { isVerified });
      
      if (!updated) {
        return res.status(404).json({ error: "Carrier not found" });
      }

      const { password: _, ...carrierWithoutPassword } = updated;
      res.json(carrierWithoutPassword);
    } catch (error) {
      console.error("Verify carrier error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin: Update carrier type (solo/enterprise)
  app.patch("/api/admin/carriers/:id/type", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { carrierType, fleetSize } = req.body;
      
      if (carrierType && !["solo", "enterprise"].includes(carrierType)) {
        return res.status(400).json({ error: "Invalid carrier type. Must be 'solo' or 'enterprise'" });
      }

      const carrierId = req.params.id;
      const carrier = await storage.getUser(carrierId);
      
      if (!carrier || carrier.role !== "carrier") {
        return res.status(404).json({ error: "Carrier not found" });
      }

      // Get existing profile or create one
      let profile = await storage.getCarrierProfile(carrierId);
      
      if (profile) {
        // Update existing profile
        const updatedProfile = await db.update(carrierProfilesTable)
          .set({
            ...(carrierType && { carrierType }),
            ...(fleetSize !== undefined && { fleetSize: parseInt(fleetSize) }),
          })
          .where(eq(carrierProfilesTable.userId, carrierId))
          .returning();
        
        res.json({ 
          success: true, 
          message: `Carrier type updated to ${carrierType || profile.carrierType}`,
          profile: updatedProfile[0] 
        });
      } else {
        // Create new profile
        const newProfile = await storage.createCarrierProfile({
          userId: carrierId,
          carrierType: carrierType || "solo",
          fleetSize: fleetSize ? parseInt(fleetSize) : 1,
          serviceZones: [],
        });
        
        res.json({ 
          success: true, 
          message: `Carrier profile created with type ${carrierType || "solo"}`,
          profile: newProfile 
        });
      }
    } catch (error) {
      console.error("Update carrier type error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin: Backfill carrier types from verification records
  app.post("/api/admin/carriers/backfill-types", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      // Get all carriers
      const carriers = await storage.getAllCarriers();
      let updated = 0;
      let skipped = 0;

      for (const carrier of carriers) {
        // Get verification record
        const verification = await storage.getCarrierVerificationByCarrier(carrier.id);
        if (!verification || !verification.carrierType) {
          skipped++;
          continue;
        }

        // Get carrier profile
        const profile = await storage.getCarrierProfile(carrier.id);
        if (!profile) {
          skipped++;
          continue;
        }

        // Sync carrier type from verification to profile if different
        if (profile.carrierType !== verification.carrierType) {
          // Properly parse fleetSize - solo drivers always have 1, enterprise use existing or 0
          const newFleetSize = verification.carrierType === "solo" 
            ? 1 
            : (typeof verification.fleetSize === 'number' 
                ? verification.fleetSize 
                : (typeof profile.fleetSize === 'number' ? profile.fleetSize : 0));
          await storage.updateCarrierProfile(carrier.id, {
            carrierType: verification.carrierType,
            fleetSize: newFleetSize
          });
          updated++;
        } else {
          skipped++;
        }
      }

      res.json({ 
        success: true, 
        message: `Backfill complete: ${updated} carriers updated, ${skipped} skipped`,
        updated,
        skipped
      });
    } catch (error) {
      console.error("Backfill carrier types error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin: Verify/reject a document
  app.patch("/api/admin/documents/:id/verify", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { isVerified, rejectionReason } = req.body;
      const docId = req.params.id;
      
      // Check if this is a truck document (format: truckId-docType)
      const truckDocPattern = /^([a-f0-9-]+)-(truck_rc|truck_insurance|truck_fitness|truck_permit|truck_puc)$/;
      const match = docId.match(truckDocPattern);
      
      if (match) {
        // This is a truck document - update the truck's document verification status
        const [, truckId, docType] = match;
        const truck = await storage.getTruck(truckId);
        
        if (!truck) {
          return res.status(404).json({ error: "Truck not found" });
        }
        
        // Verify truck belongs to a carrier
        const truckOwner = await storage.getUser(truck.carrierId);
        if (!truckOwner || truckOwner.role !== "carrier") {
          return res.status(400).json({ error: "Invalid truck ownership" });
        }
        
        // Map document type to verification field
        const verificationFieldMap: Record<string, string> = {
          truck_rc: 'rcVerified',
          truck_insurance: 'insuranceVerified',
          truck_fitness: 'fitnessVerified',
          truck_permit: 'permitVerified',
          truck_puc: 'pucVerified',
        };
        
        const verificationField = verificationFieldMap[docType];
        if (verificationField) {
          // Update truck verification status
          const updateData: any = { [verificationField]: isVerified };
          await storage.updateTruck(truckId, updateData);
        }
        
        return res.json({ 
          id: docId, 
          isVerified, 
          message: `Truck ${docType.replace('truck_', '')} document ${isVerified ? 'verified' : 'rejected'}` 
        });
      }
      
      // Regular document verification
      const document = await storage.getDocument(docId);
      
      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }

      const updated = await storage.updateDocument(docId, { 
        isVerified,
        // Could add rejectionReason field to schema if needed
      });
      
      res.json(updated);
    } catch (error) {
      console.error("Verify document error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ============================================
  // TELEMETRY API ROUTES (CAN-Bus / Vehicle Tracking)
  // ============================================

  // Get all active vehicles telemetry
  app.get("/api/telemetry/vehicles", requireAuth, async (req, res) => {
    try {
      const telemetry = getAllVehiclesTelemetry();
      res.json(telemetry);
    } catch (error) {
      console.error("Get telemetry error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get single vehicle telemetry
  app.get("/api/telemetry/vehicles/:vehicleId", requireAuth, async (req, res) => {
    try {
      const telemetry = getVehicleTelemetry(req.params.vehicleId);
      if (!telemetry) {
        return res.status(404).json({ error: "Vehicle not found" });
      }
      res.json(telemetry);
    } catch (error) {
      console.error("Get vehicle telemetry error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get vehicle list
  app.get("/api/telemetry/vehicle-ids", requireAuth, async (req, res) => {
    try {
      const vehicleIds = getActiveVehicleIds();
      res.json(vehicleIds);
    } catch (error) {
      console.error("Get vehicle IDs error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get ETA prediction for a load
  app.get("/api/telemetry/eta/:loadId", requireAuth, async (req, res) => {
    try {
      const eta = getEtaPrediction(req.params.loadId);
      if (!eta) {
        return res.status(404).json({ error: "Load not found or not in transit" });
      }
      res.json(eta);
    } catch (error) {
      console.error("Get ETA error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get GPS breadcrumbs for a vehicle
  app.get("/api/telemetry/breadcrumbs/:vehicleId", requireAuth, async (req, res) => {
    try {
      const minutes = parseInt(req.query.minutes as string) || 10;
      const breadcrumbs = getGpsBreadcrumbs(req.params.vehicleId, minutes);
      res.json(breadcrumbs);
    } catch (error) {
      console.error("Get breadcrumbs error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get driver behavior score
  app.get("/api/telemetry/driver-behavior/:driverId", requireAuth, async (req, res) => {
    try {
      const behavior = getDriverBehaviorScore(req.params.driverId);
      res.json(behavior);
    } catch (error) {
      console.error("Get driver behavior error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get all current alerts (must be before /:vehicleId route)
  app.get("/api/telemetry/alerts", requireAuth, async (req, res) => {
    try {
      const allTelemetry = getAllVehiclesTelemetry();
      const allAlerts = allTelemetry.flatMap(t => {
        const alerts = checkTelemetryAlerts(t);
        return alerts.map(alert => ({
          vehicleId: t.vehicleId,
          loadId: t.loadId,
          driverId: t.driverId,
          alert,
          timestamp: new Date().toISOString(),
        }));
      });
      res.json(allAlerts);
    } catch (error) {
      console.error("Get all alerts error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get alerts for a specific vehicle
  app.get("/api/telemetry/alerts/:vehicleId", requireAuth, async (req, res) => {
    try {
      const telemetry = getVehicleTelemetry(req.params.vehicleId);
      if (!telemetry) {
        return res.status(404).json({ error: "Vehicle not found" });
      }
      const alerts = checkTelemetryAlerts(telemetry);
      res.json(alerts);
    } catch (error) {
      console.error("Get alerts error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ==========================================
  // ADMIN-AS-MEDIATOR FLOW ENDPOINTS
  // ==========================================

  // AI-powered truck type suggestion based on weight, commodity, and market trends
  // Uses ML analysis via OpenAI to provide intelligent recommendations
  const truckSuggestionCache = new Map<string, { result: any; timestamp: number }>();
  const CACHE_TTL = 60000; // 60 seconds cache for AI suggestions
  
  // Commodity category mappings for ML analysis
  const COMMODITY_TRUCK_REQUIREMENTS: Record<string, { preferredTypes: string[]; requirements: string }> = {
    // Temperature-sensitive goods
    "frozen_foods": { preferredTypes: ["reefer_container", "container_20ft"], requirements: "refrigeration" },
    "dairy_products": { preferredTypes: ["reefer_container", "container_20ft"], requirements: "refrigeration" },
    "pharmaceuticals": { preferredTypes: ["reefer_container", "container_20ft"], requirements: "temperature_controlled" },
    "fresh_produce": { preferredTypes: ["reefer_container", "container_20ft"], requirements: "ventilation" },
    
    // Hazardous materials
    "chemicals": { preferredTypes: ["tanker_chemical", "container_20ft"], requirements: "hazmat_certified" },
    "petroleum": { preferredTypes: ["tanker_oil", "tanker_chemical"], requirements: "hazmat_certified" },
    "gases": { preferredTypes: ["tanker_chemical"], requirements: "pressure_rated" },
    
    // Bulk materials
    "cement": { preferredTypes: ["bulker_cement", "open_14_wheeler"], requirements: "covered_bulk" },
    "grains": { preferredTypes: ["bulker_cement", "container_20ft"], requirements: "food_grade" },
    "fertilizers": { preferredTypes: ["bulker_cement", "open_14_wheeler"], requirements: "covered" },
    "coal": { preferredTypes: ["dumper_hyva", "open_18_wheeler"], requirements: "open_body" },
    "sand_gravel": { preferredTypes: ["dumper_hyva", "open_14_wheeler"], requirements: "tipper" },
    "iron_ore": { preferredTypes: ["dumper_hyva", "open_18_wheeler"], requirements: "heavy_duty" },
    
    // Manufactured goods
    "electronics": { preferredTypes: ["container_20ft", "container_40ft"], requirements: "enclosed_secure" },
    "textiles": { preferredTypes: ["container_20ft", "open_20_feet"], requirements: "covered" },
    "furniture": { preferredTypes: ["container_40ft", "open_24_feet"], requirements: "large_volume" },
    "machinery": { preferredTypes: ["trailer_40ft", "lowbed_trailer"], requirements: "heavy_duty" },
    "automobiles": { preferredTypes: ["car_carrier", "trailer_40ft"], requirements: "specialized" },
    "fmcg": { preferredTypes: ["container_20ft", "open_17_feet"], requirements: "enclosed" },
    "packaged_foods": { preferredTypes: ["container_20ft", "open_17_feet"], requirements: "food_grade" },
    
    // Agricultural
    "cotton": { preferredTypes: ["container_40ft", "open_24_feet"], requirements: "high_volume" },
    "sugarcane": { preferredTypes: ["open_18_wheeler", "open_14_wheeler"], requirements: "open_body" },
    "vegetables": { preferredTypes: ["open_17_feet", "open_20_feet"], requirements: "ventilated" },
    "fruits": { preferredTypes: ["reefer_container", "open_17_feet"], requirements: "ventilated" },
    
    // Construction
    "steel": { preferredTypes: ["trailer_40ft", "open_18_wheeler"], requirements: "flatbed" },
    "timber": { preferredTypes: ["trailer_40ft", "open_24_feet"], requirements: "long_body" },
    "bricks": { preferredTypes: ["open_14_wheeler", "open_10_wheeler"], requirements: "open_body" },
    "tiles": { preferredTypes: ["container_20ft", "open_17_feet"], requirements: "enclosed" },
    
    // General
    "general_cargo": { preferredTypes: ["open_17_feet", "open_20_feet"], requirements: "standard" },
    "parcels": { preferredTypes: ["lcv_17ft", "lcv_14ft"], requirements: "enclosed" },
    "other": { preferredTypes: ["open_17_feet", "open_20_feet"], requirements: "standard" },
  };
  
  // Weight-based truck capacity mapping (in tons)
  const TRUCK_CAPACITIES: Record<string, { minWeight: number; maxWeight: number; name: string }> = {
    "mini_pickup": { minWeight: 0, maxWeight: 1, name: "Mini Pickup" },
    "lcv_tata_ace": { minWeight: 0.5, maxWeight: 1.5, name: "Tata Ace" },
    "lcv_14ft": { minWeight: 1, maxWeight: 3, name: "LCV 14 Feet" },
    "lcv_17ft": { minWeight: 2, maxWeight: 5, name: "LCV 17 Feet" },
    "open_17_feet": { minWeight: 3, maxWeight: 7, name: "Open 17 Feet" },
    "open_19_feet": { minWeight: 5, maxWeight: 9, name: "Open 19 Feet" },
    "open_20_feet": { minWeight: 6, maxWeight: 12, name: "Open 20 Feet" },
    "open_22_feet": { minWeight: 8, maxWeight: 16, name: "Open 22 Feet" },
    "open_24_feet": { minWeight: 10, maxWeight: 20, name: "Open 24 Feet" },
    "open_10_wheeler": { minWeight: 12, maxWeight: 25, name: "10 Wheeler" },
    "open_14_wheeler": { minWeight: 20, maxWeight: 35, name: "14 Wheeler" },
    "open_18_wheeler": { minWeight: 25, maxWeight: 45, name: "18 Wheeler" },
    "container_20ft": { minWeight: 5, maxWeight: 24, name: "20ft Container" },
    "container_40ft": { minWeight: 10, maxWeight: 30, name: "40ft Container" },
    "trailer_40ft": { minWeight: 15, maxWeight: 40, name: "40ft Trailer" },
    "lowbed_trailer": { minWeight: 20, maxWeight: 60, name: "Lowbed Trailer" },
    "tanker_oil": { minWeight: 10, maxWeight: 30, name: "Oil Tanker" },
    "tanker_chemical": { minWeight: 10, maxWeight: 25, name: "Chemical Tanker" },
    "bulker_cement": { minWeight: 15, maxWeight: 35, name: "Cement Bulker" },
    "dumper_hyva": { minWeight: 15, maxWeight: 30, name: "Dumper/Hyva" },
    "reefer_container": { minWeight: 5, maxWeight: 22, name: "Reefer Container" },
    "car_carrier": { minWeight: 5, maxWeight: 20, name: "Car Carrier" },
  };
  
  app.post("/api/loads/suggest-truck", requireAuth, async (req, res) => {
    try {
      // Validate input with structured commodity type
      const inputSchema = z.object({
        weight: z.union([z.string(), z.number()]).transform(v => String(v)),
        weightUnit: z.enum(["tons", "kg"]).default("tons"),
        commodityType: z.string().optional().default(""),
        goodsDescription: z.string().optional().default(""),
        pickupCity: z.string().optional().default(""),
        dropoffCity: z.string().optional().default(""),
      });
      
      const validated = inputSchema.parse(req.body);
      const numericWeight = parseFloat(validated.weight);
      
      if (isNaN(numericWeight) || numericWeight <= 0) {
        return res.status(400).json({ error: "Valid positive weight is required" });
      }
      
      // Check cache first
      const cacheKey = `${req.session.userId}-${numericWeight}-${validated.weightUnit}-${validated.commodityType}-${validated.goodsDescription}`;
      const cached = truckSuggestionCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return res.json(cached.result);
      }
      
      // Convert weight to tons
      const weightInTons = validated.weightUnit === "kg" ? numericWeight / 1000 : numericWeight;
      
      // ========================================
      // STEP 1: MARKET TREND ANALYSIS (ML Feature)
      // ========================================
      const allLoads = await storage.getAllLoads();
      
      // Filter loads by similar weight range (±30%)
      const weightSimilarLoads = allLoads.filter(load => {
        const loadWeight = parseFloat(load.weight || "0");
        return loadWeight > weightInTons * 0.7 && loadWeight < weightInTons * 1.3;
      });
      
      // Filter loads by same commodity type (if provided)
      const commoditySimilarLoads = validated.commodityType 
        ? allLoads.filter(load => {
            const loadGoods = (load.goodsToBeCarried || "").toLowerCase();
            const commodityKey = validated.commodityType.toLowerCase().replace(/\s+/g, "_");
            return loadGoods.includes(commodityKey) || loadGoods.includes(validated.commodityType.toLowerCase());
          })
        : [];
      
      // Combine weight and commodity matches with scoring
      interface LoadScore { truckType: string; score: number; source: string }
      const truckScores: LoadScore[] = [];
      
      // Weight-based matches (score: 2 points each)
      weightSimilarLoads.forEach(load => {
        if (load.requiredTruckType) {
          truckScores.push({ truckType: load.requiredTruckType, score: 2, source: "weight_match" });
        }
      });
      
      // Commodity-based matches (score: 3 points each - higher priority)
      commoditySimilarLoads.forEach(load => {
        if (load.requiredTruckType) {
          truckScores.push({ truckType: load.requiredTruckType, score: 3, source: "commodity_match" });
        }
      });
      
      // Calculate aggregate scores per truck type
      const aggregatedScores: Record<string, { totalScore: number; count: number; sources: Set<string> }> = {};
      truckScores.forEach(({ truckType, score, source }) => {
        if (!aggregatedScores[truckType]) {
          aggregatedScores[truckType] = { totalScore: 0, count: 0, sources: new Set() };
        }
        aggregatedScores[truckType].totalScore += score;
        aggregatedScores[truckType].count += 1;
        aggregatedScores[truckType].sources.add(source);
      });
      
      // Sort by score and get top recommendations from market data
      const marketRecommendations = Object.entries(aggregatedScores)
        .map(([truckType, data]) => ({
          truckType,
          score: data.totalScore,
          count: data.count,
          hasCommodityMatch: data.sources.has("commodity_match"),
          hasWeightMatch: data.sources.has("weight_match"),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      
      // ========================================
      // STEP 2: RULE-BASED ANALYSIS
      // ========================================
      const commodityKey = validated.commodityType?.toLowerCase().replace(/\s+/g, "_") || "";
      const commodityRequirements = COMMODITY_TRUCK_REQUIREMENTS[commodityKey] || COMMODITY_TRUCK_REQUIREMENTS["other"];
      
      // Find trucks that fit weight AND commodity requirements
      const weightCompatibleTrucks = Object.entries(TRUCK_CAPACITIES)
        .filter(([, capacity]) => weightInTons >= capacity.minWeight * 0.8 && weightInTons <= capacity.maxWeight * 1.1)
        .map(([type]) => type);
      
      // Intersection of commodity-preferred trucks and weight-compatible trucks
      const idealTrucks = commodityRequirements.preferredTypes.filter(t => weightCompatibleTrucks.includes(t));
      
      // Rule-based suggestion
      let ruleBasedSuggestion = idealTrucks[0] || weightCompatibleTrucks[0] || "open_10_wheeler";
      
      // Weight-only fallback if no matches
      if (!ruleBasedSuggestion || ruleBasedSuggestion === "open_10_wheeler") {
        if (weightInTons > 35) ruleBasedSuggestion = "open_18_wheeler";
        else if (weightInTons > 25) ruleBasedSuggestion = "open_14_wheeler";
        else if (weightInTons > 15) ruleBasedSuggestion = "open_10_wheeler";
        else if (weightInTons > 7) ruleBasedSuggestion = "open_20_feet";
        else if (weightInTons > 3) ruleBasedSuggestion = "open_17_feet";
        else if (weightInTons > 1) ruleBasedSuggestion = "lcv_17ft";
        else ruleBasedSuggestion = "mini_pickup";
      }
      
      // ========================================
      // STEP 3: AI/ML POWERED RECOMMENDATION
      // ========================================
      let aiSuggestion: string | null = null;
      let aiInsight: string | null = null;
      let aiConfidence: number | null = null;
      let aiAlternatives: string[] = [];
      
      if (process.env.AI_INTEGRATIONS_OPENAI_API_KEY && process.env.AI_INTEGRATIONS_OPENAI_BASE_URL) {
        try {
          const OpenAI = (await import("openai")).default;
          const openai = new OpenAI({
            apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
            baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
          });
          
          // Build market context for AI
          const marketContext = marketRecommendations.length > 0
            ? `\nMarket Data (${weightSimilarLoads.length + commoditySimilarLoads.length} similar loads analyzed):\n${marketRecommendations.slice(0, 3).map(r => `- ${r.truckType.replace(/_/g, " ")}: used ${r.count} times, score ${r.score}`).join("\n")}`
            : "\nNo historical market data available for similar loads.";
          
          const availableTruckTypes = Object.entries(TRUCK_CAPACITIES)
            .map(([type, info]) => `${type} (${info.minWeight}-${info.maxWeight} tons)`)
            .join(", ");
          
          const prompt = `You are an expert Indian logistics ML system. Analyze these inputs and recommend the optimal truck type.

INPUT DATA:
- Weight: ${weightInTons} tons
- Commodity: ${validated.commodityType || validated.goodsDescription || "General Cargo"}
- Route: ${validated.pickupCity && validated.dropoffCity ? `${validated.pickupCity} to ${validated.dropoffCity}` : "Not specified"}
${marketContext}

AVAILABLE TRUCK TYPES:
${availableTruckTypes}

COMMODITY REQUIREMENTS:
${commodityRequirements.requirements}

ANALYSIS REQUIRED:
1. Consider weight capacity (truck should have ~20% buffer above load weight)
2. Consider commodity-specific requirements (refrigeration, hazmat, bulk handling, etc.)
3. Consider market trends from historical data
4. Factor in route characteristics if provided

RESPOND IN THIS EXACT JSON FORMAT:
{
  "recommendedTruck": "truck_type_id",
  "confidence": 0.85,
  "alternatives": ["alt1", "alt2"],
  "reasoning": "One sentence explanation of why this truck is recommended",
  "factors": ["weight_optimal", "commodity_match", "market_trend"]
}`;
          
          const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{
              role: "system",
              content: "You are an ML-powered logistics optimization system specializing in Indian freight. Always respond with valid JSON only."
            }, {
              role: "user",
              content: prompt
            }],
            max_tokens: 300,
            temperature: 0.3, // Lower temperature for more consistent recommendations
          });
          
          const aiResponse = response.choices[0]?.message?.content || "";
          
          try {
            // Parse JSON response
            const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              aiSuggestion = parsed.recommendedTruck || null;
              aiInsight = parsed.reasoning || null;
              aiConfidence = parsed.confidence || null;
              aiAlternatives = parsed.alternatives || [];
            }
          } catch (parseError) {
            console.log("AI response parsing failed, using fallback:", parseError);
            // Try to extract a simple recommendation from non-JSON response
            const truckMatch = aiResponse.toLowerCase().match(/(open_\d+_(?:feet|wheeler)|container_\d+ft|trailer_\d+ft|lcv_\d+ft|tanker_\w+|bulker_\w+|dumper_\w+|reefer_\w+)/);
            if (truckMatch) {
              aiSuggestion = truckMatch[0];
            }
          }
        } catch (aiError) {
          console.error("AI suggestion error:", aiError);
        }
      }
      
      // ========================================
      // STEP 4: FINAL RECOMMENDATION (Ensemble)
      // ========================================
      // Priority: AI suggestion (if confident) > Market trend > Rule-based
      let finalSuggestion = ruleBasedSuggestion;
      let suggestionSource = "rule_based";
      let confidence = 0.6;
      
      // Use market data if available
      if (marketRecommendations.length > 0 && marketRecommendations[0].score >= 4) {
        finalSuggestion = marketRecommendations[0].truckType;
        suggestionSource = marketRecommendations[0].hasCommodityMatch ? "market_commodity" : "market_weight";
        confidence = Math.min(0.9, 0.6 + (marketRecommendations[0].count * 0.05));
      }
      
      // Override with AI suggestion if available and confident
      if (aiSuggestion && aiConfidence && aiConfidence >= 0.7) {
        finalSuggestion = aiSuggestion;
        suggestionSource = "ai_ml";
        confidence = aiConfidence;
      }
      
      // Prepare alternatives
      const alternatives = Array.from(new Set([
        ...aiAlternatives,
        ...marketRecommendations.slice(1, 3).map(r => r.truckType),
        ...idealTrucks.slice(0, 2),
      ])).filter(t => t !== finalSuggestion).slice(0, 3);
      
      const result = {
        suggestedTruck: finalSuggestion,
        alternatives,
        basedOnMarketData: suggestionSource.includes("market") || suggestionSource === "ai_ml",
        marketDataCount: weightSimilarLoads.length + commoditySimilarLoads.length,
        aiInsight: aiInsight || (suggestionSource === "ai_ml" ? "AI-optimized recommendation based on weight, commodity, and market trends" : null),
        confidence: Math.round(confidence * 100),
        suggestionSource,
        commodityRequirements: commodityRequirements.requirements,
      };
      
      // Cache the result
      truckSuggestionCache.set(cacheKey, { result, timestamp: Date.now() });
      
      // Clean up old cache entries
      if (truckSuggestionCache.size > 100) {
        const now = Date.now();
        for (const [key, value] of truckSuggestionCache.entries()) {
          if (now - value.timestamp > CACHE_TTL) {
            truckSuggestionCache.delete(key);
          }
        }
      }
      
      console.log(`[Truck Suggestion] Weight: ${weightInTons}t, Commodity: ${validated.commodityType || "general"}, Suggested: ${finalSuggestion}, Source: ${suggestionSource}, Confidence: ${result.confidence}%, MarketData: ${marketRecommendations.length} recommendations (${weightSimilarLoads.length} weight-similar, ${commoditySimilarLoads.length} commodity-similar loads)`);
      
      res.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid input", details: error.errors });
      }
      console.error("Suggest truck error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ==========================================
  // ROAD DISTANCE CALCULATION API
  // Uses OSRM (Open Source Routing Machine) - free, no API key needed
  // Falls back to Google Maps if configured
  // ==========================================
  
  // Cache for distance calculations (to reduce API calls)
  const distanceCache = new Map<string, { distance: number; duration: string; timestamp: number }>();
  const DISTANCE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours cache for distance
  
  // Geocode cache to reduce Nominatim calls
  const geocodeCache = new Map<string, { lat: number; lng: number; timestamp: number }>();
  const GEOCODE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days cache for geocoding

  // Helper: Geocode a location using OpenStreetMap Nominatim (free)
  async function geocodeLocation(location: string): Promise<{ lat: number; lng: number } | null> {
    const cacheKey = location.toLowerCase().trim();
    const cached = geocodeCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < GEOCODE_CACHE_TTL) {
      return { lat: cached.lat, lng: cached.lng };
    }
    
    try {
      // Add ", India" for better accuracy with Indian cities
      const searchQuery = location.toLowerCase().includes("india") ? location : `${location}, India`;
      
      const url = new URL("https://nominatim.openstreetmap.org/search");
      url.searchParams.set("q", searchQuery);
      url.searchParams.set("format", "json");
      url.searchParams.set("limit", "1");
      
      const response = await fetch(url.toString(), {
        headers: {
          "User-Agent": "LoadSmart/1.0 (logistics platform)"
        }
      });
      
      const data = await response.json();
      
      if (data && data.length > 0) {
        const result = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
        geocodeCache.set(cacheKey, { ...result, timestamp: Date.now() });
        return result;
      }
      
      return null;
    } catch (error) {
      console.error("[Geocode] Error geocoding location:", location, error);
      return null;
    }
  }
  
  // Helper: Format duration from seconds
  function formatDuration(durationSeconds: number): string {
    const hours = Math.floor(durationSeconds / 3600);
    const minutes = Math.floor((durationSeconds % 3600) / 60);
    if (hours >= 24) {
      const days = Math.floor(hours / 10); // Assume 10 hours driving per day
      return `${days} day${days > 1 ? "s" : ""}`;
    } else if (hours > 0) {
      return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    } else {
      return `${minutes} mins`;
    }
  }

  // Calculate road distance between two locations (public API - no auth needed)
  app.post("/api/distance/calculate", async (req, res) => {
    try {
      const inputSchema = z.object({
        origin: z.string().min(2, "Origin is required"),
        destination: z.string().min(2, "Destination is required"),
      });
      
      const { origin, destination } = inputSchema.parse(req.body);
      
      // Create cache key (normalized)
      const cacheKey = `${origin.toLowerCase().trim()}_${destination.toLowerCase().trim()}`;
      
      // Check cache first
      const cached = distanceCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < DISTANCE_CACHE_TTL) {
        console.log(`[Distance API] Cache hit for ${origin} -> ${destination}`);
        return res.json({
          distance: cached.distance,
          duration: cached.duration,
          source: "cache"
        });
      }
      
      // Try Google Maps first if API key is available
      const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
      
      if (GOOGLE_MAPS_API_KEY) {
        try {
          const formatLocation = (loc: string) => {
            const normalized = loc.trim();
            if (!normalized.toLowerCase().includes("india")) {
              return `${normalized}, India`;
            }
            return normalized;
          };
          
          const originFormatted = formatLocation(origin);
          const destFormatted = formatLocation(destination);
          
          console.log(`[Distance API] Calling Google Maps API: ${originFormatted} -> ${destFormatted}`);
          
          const apiUrl = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
          apiUrl.searchParams.set("origins", originFormatted);
          apiUrl.searchParams.set("destinations", destFormatted);
          apiUrl.searchParams.set("mode", "driving");
          apiUrl.searchParams.set("units", "metric");
          apiUrl.searchParams.set("key", GOOGLE_MAPS_API_KEY);
          
          const response = await fetch(apiUrl.toString());
          const data = await response.json();
          
          if (data.status === "OK" && data.rows?.[0]?.elements?.[0]?.status === "OK") {
            const element = data.rows[0].elements[0];
            const distanceKm = Math.round(element.distance.value / 1000);
            const durationStr = formatDuration(element.duration.value);
            
            console.log(`[Distance API] Google Maps result: ${distanceKm} km, ${durationStr}`);
            
            distanceCache.set(cacheKey, { distance: distanceKm, duration: durationStr, timestamp: Date.now() });
            
            return res.json({
              distance: distanceKm,
              duration: durationStr,
              source: "google_maps",
              originResolved: data.origin_addresses?.[0],
              destinationResolved: data.destination_addresses?.[0]
            });
          }
        } catch (googleError) {
          console.error("[Distance API] Google Maps failed, trying OSRM:", googleError);
        }
      }
      
      // Use OSRM (Open Source Routing Machine) - free, no API key needed
      console.log(`[Distance API] Using OSRM for: ${origin} -> ${destination}`);
      
      // First, geocode both locations
      const [originCoords, destCoords] = await Promise.all([
        geocodeLocation(origin),
        geocodeLocation(destination)
      ]);
      
      if (!originCoords) {
        console.error("[Distance API] Could not geocode origin:", origin);
        return res.status(400).json({
          error: "Could not find origin location",
          details: `Unable to geocode: ${origin}`,
          source: "geocode_error"
        });
      }
      
      if (!destCoords) {
        console.error("[Distance API] Could not geocode destination:", destination);
        return res.status(400).json({
          error: "Could not find destination location",
          details: `Unable to geocode: ${destination}`,
          source: "geocode_error"
        });
      }
      
      console.log(`[Distance API] Coordinates: ${originCoords.lat},${originCoords.lng} -> ${destCoords.lat},${destCoords.lng}`);
      
      // Call OSRM routing API
      const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${originCoords.lng},${originCoords.lat};${destCoords.lng},${destCoords.lat}?overview=false`;
      
      const osrmResponse = await fetch(osrmUrl, {
        headers: {
          "User-Agent": "LoadSmart/1.0 (logistics platform)"
        }
      });
      
      const osrmData = await osrmResponse.json();
      
      if (osrmData.code !== "Ok" || !osrmData.routes || osrmData.routes.length === 0) {
        console.error("[Distance API] OSRM error:", osrmData.code, osrmData.message);
        return res.status(400).json({
          error: "No route found between these locations",
          details: osrmData.message || osrmData.code,
          source: "osrm_error"
        });
      }
      
      const route = osrmData.routes[0];
      const distanceKm = Math.round(route.distance / 1000);
      const durationStr = formatDuration(route.duration);
      
      console.log(`[Distance API] OSRM result: ${distanceKm} km, ${durationStr}`);
      
      // Cache the result
      distanceCache.set(cacheKey, {
        distance: distanceKm,
        duration: durationStr,
        timestamp: Date.now()
      });
      
      // Clean up old cache entries periodically
      if (distanceCache.size > 500) {
        const now = Date.now();
        for (const [key, value] of distanceCache.entries()) {
          if (now - value.timestamp > DISTANCE_CACHE_TTL) {
            distanceCache.delete(key);
          }
        }
      }
      
      res.json({
        distance: distanceKm,
        duration: durationStr,
        source: "osrm"
      });
      
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: "Invalid input", details: error.errors });
      }
      console.error("[Distance API] Error:", error);
      res.status(500).json({ error: "Failed to calculate distance" });
    }
  });

  // Shipper submits load to Admin for pricing (no rate required)
  app.post("/api/loads/submit", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "shipper") {
        return res.status(403).json({ error: "Only shippers can submit loads" });
      }

      const body = { ...req.body };
      if (body.pickupDate && typeof body.pickupDate === 'string') {
        body.pickupDate = new Date(body.pickupDate);
      }
      if (body.deliveryDate && typeof body.deliveryDate === 'string') {
        body.deliveryDate = new Date(body.deliveryDate);
      }
      if (typeof body.weight === 'string') {
        const parsed = parseFloat(body.weight);
        body.weight = (!body.weight || isNaN(parsed)) ? 0 : parsed;
      } else if (body.weight === undefined || body.weight === null) {
        body.weight = 0;
      }

      // Get next sequential global load number
      const shipperLoadNumber = await storage.getNextGlobalLoadNumber();

      const data = insertLoadSchema.parse({
        ...body,
        pickupAddress: body.pickupAddress || "",
        pickupCity: body.pickupCity || "",
        dropoffAddress: body.dropoffAddress || "",
        dropoffCity: body.dropoffCity || "",
        shipperId: user.id,
        shipperLoadNumber,
        status: 'pending',
        submittedAt: new Date(),
      });

      const load = await storage.createLoad(data);

      // Create notification for admins
      const admins = (await storage.getAllUsers()).filter(u => u.role === 'admin');
      for (const admin of admins) {
        await storage.createNotification({
          userId: admin.id,
          title: "New Load Submitted",
          message: `${user.companyName || user.username} submitted a new load${load.pickupCity && load.dropoffCity ? ` from ${load.pickupCity} to ${load.dropoffCity}` : ''}`,
          type: "info",
          relatedLoadId: load.id,
        });
      }

      res.json({ load_id: load.id, load_number: load.shipperLoadNumber, status: 'pending' });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Submit load error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin queue - list loads pending admin review
  app.get("/api/admin/queue", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const pendingLoads = await storage.getLoadsSubmittedToAdmin();
      
      // Enrich with shipper info
      const enrichedLoads = await Promise.all(
        pendingLoads.map(async (load) => {
          const shipper = await storage.getUser(load.shipperId);
          return {
            ...load,
            shipperName: shipper?.companyName || shipper?.username,
            shipperEmail: shipper?.email,
          };
        })
      );

      res.json(enrichedLoads);
    } catch (error) {
      console.error("Get admin queue error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin prices and posts a load
  app.post("/api/admin/price", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { load_id, suggested_price, final_price, post_mode, invite_carrier_ids, comment, allow_counter_bids, advance_payment_percent } = req.body;

      if (!load_id || !final_price || !post_mode) {
        return res.status(400).json({ error: "load_id, final_price, and post_mode are required" });
      }

      const load = await storage.getLoad(load_id);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      // Create admin decision record (immutable audit trail)
      const decision = await storage.createAdminDecision({
        loadId: load_id,
        adminId: user.id,
        suggestedPrice: suggested_price || final_price,
        finalPrice: final_price,
        postingMode: post_mode,
        invitedCarrierIds: invite_carrier_ids || null,
        comment: comment || null,
        pricingBreakdown: req.body.pricing_breakdown || null,
        actionType: 'price_and_post',
      });

      // Determine status based on post mode - Use canonical lifecycle states
      // posted_to_carriers = visible to carriers, open_for_bid = active bidding
      let newStatus = 'posted_to_carriers';
      if (post_mode === 'assign') {
        newStatus = 'awarded'; // Direct assignment skips bidding
      }

      // NOTE: Invoice is NOT created here per Admin-as-Mediator workflow
      // Invoice is only generated AFTER carrier is finalized (awarded state)
      // This happens in acceptBid() workflow service or when admin transitions to invoice_sent

      // Assign admin reference number if not already assigned
      let adminReferenceNumber = load.adminReferenceNumber;
      if (!adminReferenceNumber) {
        adminReferenceNumber = await storage.getNextAdminReferenceNumber(load.shipperId);
      }

      // Calculate carrier payout (price after platform margin deduction)
      const finalPriceNum = parseFloat(final_price);
      const platformMarginPercent = parseFloat(req.body.platform_margin_percent || '10');
      const platformMargin = Math.round(finalPriceNum * (platformMarginPercent / 100));
      const payoutEstimate = Math.round(finalPriceNum - platformMargin);

      // Update load with admin pricing
      // NOTE: Do NOT overwrite advancePaymentPercent - this is the shipper's preference for invoicing
      // Admin's carrier advance is separate (carrierAdvancePercent) for marketplace display
      // IMPORTANT: finalPrice = carrier payout, adminFinalPrice = shipper's gross price
      const updatedLoad = await storage.updateLoad(load_id, {
        adminSuggestedPrice: suggested_price || final_price,
        adminFinalPrice: final_price,
        finalPrice: payoutEstimate.toString(),
        adminPostMode: post_mode,
        adminId: user.id,
        adminDecisionId: decision.id,
        invitedCarrierIds: invite_carrier_ids || null,
        allowCounterBids: allow_counter_bids || false,
        carrierAdvancePercent: advance_payment_percent || 0,
        status: newStatus,
        postedAt: new Date(),
        adminReferenceNumber,
      });

      // Notify shipper
      await storage.createNotification({
        userId: load.shipperId,
        title: "Load Posted by Admin",
        message: `Your load from ${load.pickupCity} to ${load.dropoffCity} has been priced at Rs. ${final_price} and posted to carriers.`,
        type: "success",
        relatedLoadId: load_id,
      });

      // If invite mode, notify invited carriers
      if (post_mode === 'invite' && invite_carrier_ids?.length > 0) {
        for (const carrierId of invite_carrier_ids) {
          await storage.createNotification({
            userId: carrierId,
            title: "Invited to Bid on Load",
            message: `You have been invited to bid on a load from ${load.pickupCity} to ${load.dropoffCity}`,
            type: "info",
            relatedLoadId: load_id,
          });
        }
      }

      // Broadcast real-time update to carrier clients
      if (newStatus === 'posted_to_carriers') {
        broadcastLoadPosted({
          id: load_id,
          pickupCity: load.pickupCity,
          dropoffCity: load.dropoffCity,
          adminFinalPrice: final_price,
          requiredTruckType: load.requiredTruckType,
          status: newStatus,
        });
      }

      res.json({ 
        success: true, 
        load: updatedLoad, 
        decision_id: decision.id,
        status: newStatus,
        message: "Load priced and posted to carriers. Invoice will be generated after carrier is finalized."
      });
    } catch (error) {
      console.error("Admin price error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get admin decision history for a load
  app.get("/api/admin/audit/:loadId", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const decisions = await storage.getAdminDecisionsByLoad(req.params.loadId);
      
      // Enrich with admin info
      const enrichedDecisions = await Promise.all(
        decisions.map(async (decision) => {
          const admin = await storage.getUser(decision.adminId);
          return {
            ...decision,
            adminName: admin?.username,
            adminEmail: admin?.email,
          };
        })
      );

      res.json(enrichedDecisions);
    } catch (error) {
      console.error("Get audit error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ============================
  // ADMIN NEGOTIATION CHAT ROUTES
  // ============================

  // Get all negotiation threads with load details
  app.get("/api/admin/negotiations", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      // Get loads that are in negotiation states (including awarded for post-acceptance invoice flow)
      const negotiableStatuses = ["posted_to_carriers", "open_for_bid", "counter_received", "awarded", "open_for_bids"];
      const loads = await storage.getLoadsByStatuses(negotiableStatuses as any);
      
      // Enrich with negotiation thread data
      const enrichedLoads = await Promise.all(
        loads.map(async (load) => {
          const thread = await storage.getOrCreateNegotiationThread(load.id);
          const shipper = await storage.getUser(load.shipperId);
          const bids = await storage.getBidsByLoad(load.id);
          const messages = await storage.getBidNegotiationsByLoad(load.id);
          
          return {
            ...load,
            shipperName: shipper?.companyName || shipper?.username,
            shipperEmail: shipper?.email,
            thread,
            bidCount: bids.length,
            messageCount: messages.length,
            latestActivity: messages.length > 0 
              ? messages[messages.length - 1].createdAt 
              : thread.lastActivityAt,
          };
        })
      );

      // Get counters for dashboard
      const counters = await storage.getNegotiationCounters();

      res.json({ loads: enrichedLoads, counters });
    } catch (error) {
      console.error("Get negotiations error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get negotiation thread and messages for a specific load
  app.get("/api/admin/negotiations/:loadId", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { loadId } = req.params;
      const load = await storage.getLoad(loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      const thread = await storage.getOrCreateNegotiationThread(loadId);
      const messages = await storage.getBidNegotiationsByLoad(loadId);
      const bids = await storage.getBidsByLoad(loadId);
      const shipper = await storage.getUser(load.shipperId);

      // Enrich bids with carrier info
      const enrichedBids = await Promise.all(
        bids.map(async (bid) => {
          const carrier = await storage.getUser(bid.carrierId);
          return {
            ...bid,
            carrierName: carrier?.companyName || carrier?.username,
            carrierEmail: carrier?.email,
          };
        })
      );

      res.json({
        load: {
          ...load,
          shipperName: shipper?.companyName || shipper?.username,
        },
        thread,
        messages,
        bids: enrichedBids,
      });
    } catch (error) {
      console.error("Get negotiation thread error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin sends counter-offer in negotiation
  app.post("/api/admin/negotiations/:loadId/counter", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { loadId } = req.params;
      const counterSchema = z.object({
        bidId: z.string(),
        counterAmount: z.string(),
        message: z.string().optional(),
      });

      const { bidId, counterAmount, message } = counterSchema.parse(req.body);

      const load = await storage.getLoad(loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      const bid = await storage.getBid(bidId);
      if (!bid) {
        return res.status(404).json({ error: "Bid not found" });
      }

      // Update bid with counter amount
      await storage.updateBid(bidId, { 
        counterAmount,
        status: "countered",
      });

      // Create negotiation message
      const negotiationMessage = await storage.createBidNegotiation({
        bidId,
        loadId,
        senderId: user.id,
        senderRole: "admin",
        messageType: "admin_counter",
        message: message || `Counter offer: Rs. ${Number(counterAmount).toLocaleString('en-IN')}`,
        amount: counterAmount,
        previousAmount: bid.amount,
        carrierName: null,
        isSimulated: false,
      });

      // Update thread status
      await storage.updateNegotiationThread(loadId, {
        status: "counter_sent",
        pendingCounters: 1,
        lastActivityAt: new Date(),
      });

      // Update load status to counter_received
      await storage.updateLoad(loadId, { status: "counter_received" });

      // Notify carrier
      await storage.createNotification({
        userId: bid.carrierId,
        title: "Counter Offer Received",
        message: `Admin has countered your bid with Rs. ${Number(counterAmount).toLocaleString('en-IN')}`,
        type: "warning",
        relatedLoadId: loadId,
        contextType: "counter_offer",
      });

      // Broadcast real-time counter event to carrier
      broadcastBidCountered(bid.carrierId, loadId, {
        bidId,
        counterAmount,
        message: message || `Counter offer: Rs. ${Number(counterAmount).toLocaleString('en-IN')}`,
        loadPickup: load.pickupCity,
        loadDropoff: load.dropoffCity,
      });

      // Broadcast negotiation message to carrier for real-time chat sync
      broadcastNegotiationMessage("carrier", bid.carrierId, bidId, {
        ...negotiationMessage,
        senderName: "Admin",
        loadId,
        action: "admin_counter",
      });

      res.json({ success: true, message: negotiationMessage });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Counter offer error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin accepts a bid in negotiation
  app.post("/api/admin/negotiations/:loadId/accept", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { loadId } = req.params;
      const acceptSchema = z.object({
        bidId: z.string(),
      });

      const { bidId } = acceptSchema.parse(req.body);

      const load = await storage.getLoad(loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      const bid = await storage.getBid(bidId);
      if (!bid) {
        return res.status(404).json({ error: "Bid not found" });
      }

      // Accept the winning bid
      await storage.updateBid(bidId, { status: "accepted" });

      // Reject all other bids for this load
      const allBids = await storage.getBidsByLoad(loadId);
      for (const otherBid of allBids) {
        if (otherBid.id !== bidId && otherBid.status !== "rejected") {
          await storage.updateBid(otherBid.id, { status: "rejected" });
          // Notify rejected carriers
          await storage.createNotification({
            userId: otherBid.carrierId,
            title: "Bid Not Selected",
            message: `Another carrier was selected for the load from ${load.pickupCity} to ${load.dropoffCity}`,
            type: "info",
            relatedLoadId: loadId,
          });
        }
      }

      // Get the final amount (counter amount if exists, otherwise original bid)
      const finalAmount = bid.counterAmount || bid.amount;

      // Create acceptance message in chat
      const carrier = await storage.getUser(bid.carrierId);
      await storage.createBidNegotiation({
        bidId,
        loadId,
        senderId: user.id,
        senderRole: "system",
        messageType: "admin_accept",
        message: `Carrier finalized at Rs. ${Number(finalAmount).toLocaleString('en-IN')}`,
        amount: finalAmount,
        carrierName: carrier?.companyName || carrier?.username,
        isSimulated: false,
      });

      // Update thread to accepted
      await storage.acceptBidInThread(loadId, bidId, bid.carrierId, finalAmount);

      // Generate unique 4-digit pickup ID for carrier verification
      const pickupId = await storage.generateUniquePickupId();

      // Update load status to invoice_created - shipment created after shipper acknowledges
      await storage.updateLoad(loadId, { 
        status: "invoice_created",
        assignedCarrierId: bid.carrierId,
        finalPrice: finalAmount,
        awardedBidId: bidId,
        pickupId: pickupId,
      });

      // Auto-create invoice when bid is accepted
      try {
        const existingInvoice = await storage.getInvoiceByLoad(loadId);
        if (!existingInvoice) {
          const invoiceNumber = await storage.generateInvoiceNumber();
          const totalWithTax = (parseFloat(finalAmount) * 1.18).toFixed(2);
          
          // Calculate advance payment from load
          const advancePercent = load.advancePaymentPercent || 0;
          const advanceAmount = advancePercent > 0 ? (parseFloat(totalWithTax) * (advancePercent / 100)).toFixed(2) : null;
          const balanceOnDelivery = advancePercent > 0 ? (parseFloat(totalWithTax) - parseFloat(advanceAmount || "0")).toFixed(2) : null;
          
          await storage.createInvoice({
            invoiceNumber,
            loadId: loadId,
            shipperId: load.shipperId,
            adminId: user.id,
            subtotal: finalAmount,
            fuelSurcharge: "0",
            tollCharges: "0",
            handlingFee: "0",
            insuranceFee: "0",
            discountAmount: "0",
            discountReason: null,
            taxPercent: "18",
            taxAmount: (parseFloat(finalAmount) * 0.18).toFixed(2),
            totalAmount: totalWithTax,
            advancePaymentPercent: advancePercent > 0 ? advancePercent : null,
            advancePaymentAmount: advanceAmount,
            balanceOnDelivery: balanceOnDelivery,
            paymentTerms: "Net 30",
            dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            notes: `Invoice generated for load ${loadId} after carrier finalization`,
            lineItems: [{
              description: `Freight services: ${load.pickupCity} to ${load.dropoffCity}`,
              quantity: 1,
              rate: finalAmount,
              amount: finalAmount
            }],
            status: "draft",
          });
        }
      } catch (invoiceError) {
        console.error("Failed to create invoice after admin acceptance:", invoiceError);
      }

      // Notify winning carrier
      await storage.createNotification({
        userId: bid.carrierId,
        title: "Bid Accepted!",
        message: `Your bid for load from ${load.pickupCity} to ${load.dropoffCity} has been accepted at Rs. ${Number(finalAmount).toLocaleString('en-IN')}`,
        type: "success",
        relatedLoadId: loadId,
      });

      // Notify shipper
      await storage.createNotification({
        userId: load.shipperId,
        title: "Carrier Assigned",
        message: `A carrier has been assigned for your load from ${load.pickupCity} to ${load.dropoffCity}`,
        type: "success",
        relatedLoadId: loadId,
      });

      // Broadcast real-time bid accepted event to carrier
      broadcastBidAccepted(bid.carrierId, loadId, {
        bidId,
        finalAmount,
        loadPickup: load.pickupCity,
        loadDropoff: load.dropoffCity,
        carrierName: carrier?.companyName || carrier?.username,
      });

      res.json({ 
        success: true, 
        message: "Bid accepted and carrier finalized",
        finalAmount,
        carrierId: bid.carrierId,
        carrierName: carrier?.companyName || carrier?.username,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Accept bid error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin rejects a bid in negotiation
  app.post("/api/admin/negotiations/:loadId/reject", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { loadId } = req.params;
      const rejectSchema = z.object({
        bidId: z.string(),
        reason: z.string().optional(),
      });

      const { bidId, reason } = rejectSchema.parse(req.body);

      const bid = await storage.getBid(bidId);
      if (!bid) {
        return res.status(404).json({ error: "Bid not found" });
      }

      const load = await storage.getLoad(loadId);

      // Reject the bid
      await storage.updateBid(bidId, { status: "rejected" });

      // Create rejection message in chat
      await storage.createBidNegotiation({
        bidId,
        loadId,
        senderId: user.id,
        senderRole: "admin",
        messageType: "admin_reject",
        message: reason || "Bid rejected by admin",
        amount: bid.amount,
        isSimulated: false,
      });

      // Notify carrier
      await storage.createNotification({
        userId: bid.carrierId,
        title: "Bid Rejected",
        message: reason || `Your bid for load from ${load?.pickupCity} to ${load?.dropoffCity} was not accepted`,
        type: "warning",
        relatedLoadId: loadId,
      });

      res.json({ success: true, message: "Bid rejected" });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Reject bid error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Generate simulated bid for a load
  app.post("/api/admin/negotiations/:loadId/simulate", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { loadId } = req.params;
      const load = await storage.getLoad(loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      // Generate simulated carrier names
      const simulatedCarrierNames = [
        "Swift Logistics",
        "Premium Freight Co",
        "Highway Express",
        "National Transport",
        "Metro Carriers",
        "Rapid Delivery",
        "Elite Trucking",
        "Prime Movers",
      ];

      const carrierName = simulatedCarrierNames[Math.floor(Math.random() * simulatedCarrierNames.length)];
      
      // Generate realistic bid amount based on admin price
      const basePrice = Number(load.adminFinalPrice) || 50000;
      const variance = 0.1 + Math.random() * 0.15; // 10-25% variance
      const bidAmount = Math.round(basePrice * (1 - variance));

      // Create simulated bid message
      const message = await storage.createBidNegotiation({
        loadId,
        senderRole: "carrier",
        messageType: "simulated_bid",
        message: `Bid placed: Rs. ${bidAmount.toLocaleString('en-IN')}`,
        amount: bidAmount.toString(),
        isSimulated: true,
        simulatedCarrierName: carrierName,
        carrierType: Math.random() > 0.5 ? "enterprise" : "solo",
      });

      // Update thread bid count
      await storage.incrementThreadBidCount(loadId, true);

      res.json({ success: true, message, carrierName, bidAmount });
    } catch (error) {
      console.error("Simulate bid error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get negotiation counters for dashboard
  app.get("/api/admin/negotiations/counters", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const counters = await storage.getNegotiationCounters();
      res.json(counters);
    } catch (error) {
      console.error("Get counters error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Real-time analytics endpoint for admin dashboard (optimized with SQL aggregations)
  app.get("/api/admin/analytics/realtime", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      // Use optimized SQL aggregation methods instead of loading all data
      const [negotiationStats, profitStats] = await Promise.all([
        storage.getRealtimeNegotiationAnalytics(),
        storage.getRealtimeProfitMarginAnalytics(),
      ]);

      // Calculate negotiation rate
      const totalAccepts = negotiationStats.directAccepts + negotiationStats.negotiatedAccepts;
      const negotiationRate = totalAccepts > 0 
        ? Math.round((negotiationStats.negotiatedAccepts / totalAccepts) * 100) 
        : 0;

      res.json({
        // Negotiation Analytics
        negotiations: {
          activeLoads: negotiationStats.activeLoads,
          pendingBids: negotiationStats.pendingBids,
          counteredBids: negotiationStats.counteredBids,
          acceptedBids: negotiationStats.acceptedBids,
          recentBids24h: negotiationStats.recentBids24h,
          recentCounters24h: negotiationStats.recentCounters24h,
          directAccepts: negotiationStats.directAccepts,
          negotiatedAccepts: negotiationStats.negotiatedAccepts,
          negotiationRate,
        },
        // Profit Margin Analytics  
        profitMargin: profitStats,
        // Today's Activity
        today: {
          newBids: negotiationStats.todayBids,
          counterOffers: negotiationStats.todayCounters,
          acceptedBids: negotiationStats.todayAccepts,
        },
        // Timestamp for real-time display
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("Get realtime analytics error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get admin-posted loads for carriers (with eligibility filters)
  app.get("/api/carrier/loads", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      const adminPostedLoads = await storage.getAdminPostedLoads();
      
      // Apply full carrier eligibility checks from workflow service
      const eligibleLoads: typeof adminPostedLoads = [];
      for (const load of adminPostedLoads) {
        const eligibility = await checkCarrierEligibility(user.id, load);
        if (eligibility.eligible) {
          eligibleLoads.push(load);
        }
      }

      const enrichedLoads = await Promise.all(
        eligibleLoads.map(async (load) => {
          const shipper = await storage.getUser(load.shipperId);
          const loadBids = await storage.getBidsByLoad(load.id);
          const myBid = loadBids.find(b => b.carrierId === user.id);
          return {
            ...load,
            shipperName: shipper?.companyName || shipper?.username,
            bidCount: loadBids.length,
            myBid: myBid || null,
            postedByAdmin: true,
            priceFixed: !load.allowCounterBids,
          };
        })
      );

      res.json(enrichedLoads);
    } catch (error) {
      console.error("Get carrier loads error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Solo carrier available loads - same as enterprise loads (with eligibility filters)
  app.get("/api/carrier/available-loads", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      const adminPostedLoads = await storage.getAdminPostedLoads();
      
      // Apply full carrier eligibility checks from workflow service
      const eligibleLoads: typeof adminPostedLoads = [];
      for (const load of adminPostedLoads) {
        const eligibility = await checkCarrierEligibility(user.id, load);
        if (eligibility.eligible) {
          eligibleLoads.push(load);
        }
      }

      const enrichedLoads = await Promise.all(
        eligibleLoads.map(async (load) => {
          const shipper = await storage.getUser(load.shipperId);
          const loadBids = await storage.getBidsByLoad(load.id);
          const myBid = loadBids.find(b => b.carrierId === user.id);
          return {
            ...load,
            shipperName: shipper?.companyName || shipper?.username,
            bidCount: loadBids.length,
            myBid: myBid || null,
            postedByAdmin: true,
            priceFixed: !load.allowCounterBids,
          };
        })
      );

      res.json(enrichedLoads);
    } catch (error) {
      console.error("Get carrier available loads error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Carrier accepts admin price or submits counter bid
  app.post("/api/bids/submit", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Only carriers can submit bids" });
      }

      const { load_id, amount, bid_type, notes, truck_id, driver_id, carrier_type } = req.body;

      const load = await storage.getLoad(load_id);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      // Use workflow service to check carrier eligibility
      const canBid = await canUserBidOnLoad(user.id, load_id);
      if (!canBid.allowed) {
        return res.status(403).json({ error: canBid.reason });
      }
      
      // Fleet carrier restriction: truck and driver can only be assigned to one active load at a time
      // Get carrier profile to check if this is a fleet carrier
      const carrierProfileForValidation = await storage.getCarrierProfile(user.id);
      const isFleetCarrier = carrierProfileForValidation?.carrierType === 'enterprise' || carrierProfileForValidation?.carrierType === 'fleet' || carrier_type === 'enterprise';
      
      if (isFleetCarrier) {
        // Terminal statuses - truck/driver can be reused once delivery reaches these states
        const terminalStatuses = ['delivered', 'closed', 'cancelled', 'completed'];
        
        // Get all shipments for this carrier
        const carrierShipments = await storage.getShipmentsByCarrier(user.id);
        const allBids = await storage.getBidsByCarrier(user.id);
        
        // Check if truck is already assigned to an active shipment or accepted bid
        if (truck_id) {
          const truckInUse = carrierShipments.find(s => 
            s.truckId === truck_id && 
            !terminalStatuses.includes(s.status || '')
          );
          
          if (truckInUse) {
            const activeLoad = await storage.getLoad(truckInUse.loadId);
            return res.status(400).json({ 
              error: `This truck is already assigned to an active shipment (${activeLoad?.pickupCity || 'Unknown'} to ${activeLoad?.dropoffCity || 'Unknown'}). Please wait until delivery is completed before assigning this truck to a new load.`
            });
          }
          
          // Check accepted bids without shipments yet (only if load is still active)
          let truckBidInProgress = null;
          for (const b of allBids) {
            if (b.truckId === truck_id && b.status === 'accepted') {
              const bidLoad = await storage.getLoad(b.loadId);
              if (bidLoad && !terminalStatuses.includes(bidLoad.status || '')) {
                truckBidInProgress = b;
                break;
              }
            }
          }
          if (truckBidInProgress) {
            const activeLoad = await storage.getLoad(truckBidInProgress.loadId);
            return res.status(400).json({ 
              error: `This truck is already assigned to an accepted bid (${activeLoad?.pickupCity || 'Unknown'} to ${activeLoad?.dropoffCity || 'Unknown'}). Please wait until delivery is completed.`
            });
          }
        }
        
        // Check if driver is already assigned to an active shipment or accepted bid
        if (driver_id && driver_id !== 'unassigned') {
          const driverInUse = carrierShipments.find(s => 
            s.driverId === driver_id && 
            !terminalStatuses.includes(s.status || '')
          );
          
          if (driverInUse) {
            const activeLoad = await storage.getLoad(driverInUse.loadId);
            return res.status(400).json({ 
              error: `This driver is already assigned to an active shipment (${activeLoad?.pickupCity || 'Unknown'} to ${activeLoad?.dropoffCity || 'Unknown'}). Please wait until delivery is completed before assigning this driver to a new load.`
            });
          }
          
          // Check accepted bids for driver (only if load is still active)
          let driverBidInProgress = null;
          for (const b of allBids) {
            if (b.driverId === driver_id && b.status === 'accepted') {
              const bidLoad = await storage.getLoad(b.loadId);
              if (bidLoad && !terminalStatuses.includes(bidLoad.status || '')) {
                driverBidInProgress = b;
                break;
              }
            }
          }
          if (driverBidInProgress) {
            const activeLoad = await storage.getLoad(driverBidInProgress.loadId);
            return res.status(400).json({ 
              error: `This driver is already assigned to an accepted bid (${activeLoad?.pickupCity || 'Unknown'} to ${activeLoad?.dropoffCity || 'Unknown'}). Please wait until delivery is completed.`
            });
          }
        }
      }

      // Check if load allows counter bids
      if (bid_type === 'counter' && !load.allowCounterBids) {
        return res.status(403).json({ error: "Counter bids not allowed for this load" });
      }

      // Determine bid type and amount
      let finalBidType = bid_type || 'carrier_bid';
      let finalAmount = amount;

      if (bid_type === 'admin_posted_acceptance') {
        finalAmount = load.finalPrice;
        finalBidType = 'admin_posted_acceptance';
      }

      // Get carrier type from carrier profile (authoritative source), not request
      const carrierProfile = await storage.getCarrierProfile(user.id);
      const finalCarrierType = carrierProfile?.carrierType || carrier_type || 'enterprise';

      const bid = await storage.createBid({
        loadId: load_id,
        carrierId: user.id,
        truckId: truck_id || null,
        driverId: driver_id && driver_id !== 'unassigned' ? driver_id : null,
        amount: finalAmount,
        notes: notes || null,
        status: 'pending',
        bidType: finalBidType,
        carrierType: finalCarrierType,
        adminMediated: !!load.adminId,
        approvalRequired: bid_type === 'counter',
      });

      // Update load status based on bid type - use canonical states
      // ADMIN-AS-MEDIATOR: ALL bids stay pending until admin reviews and accepts
      // This enables multiple carriers to bid simultaneously
      if (bid_type === 'counter') {
        // Counter-bid submitted, needs admin review - load remains open for other bids
        await storage.updateLoad(load_id, {
          status: 'open_for_bid',
          previousStatus: load.status,
          statusChangedAt: new Date(),
        });
        console.log(`Counter bid ${bid.id} created for load ${load_id} - awaiting admin review`);
      } else if (bid_type === 'admin_posted_acceptance') {
        // CARRIER ACCEPTED ADMIN PRICE: Bid stays pending for admin review
        // Load remains open for other carriers to also bid
        await storage.updateLoad(load_id, {
          status: 'open_for_bid',
          previousStatus: load.status,
          statusChangedAt: new Date(),
        });
        console.log(`Bid ${bid.id} created for load ${load_id} at admin price - awaiting admin review`);
      }

      // Notify shipper and admin
      if (load.shipperId) {
        await storage.createNotification({
          userId: load.shipperId,
          title: bid_type === 'admin_posted_acceptance' ? "Carrier Accepted Your Load" : "New Bid Received",
          message: `${user.companyName || user.username} ${bid_type === 'admin_posted_acceptance' ? 'accepted' : 'submitted a bid for'} your load`,
          type: "info",
          relatedLoadId: load_id,
          relatedBidId: bid.id,
        });
      }

      if (load.adminId) {
        await storage.createNotification({
          userId: load.adminId,
          title: bid_type === 'admin_posted_acceptance' ? "Carrier Accepted Admin Price" : "Carrier Counter Bid",
          message: `${user.companyName || user.username} ${bid_type === 'admin_posted_acceptance' ? 'accepted the admin price' : `countered with Rs. ${amount}`}`,
          type: "info",
          relatedLoadId: load_id,
          relatedBidId: bid.id,
        });
      }

      // Broadcast real-time bid received event to admins
      broadcastBidReceived(load_id, {
        bidId: bid.id,
        carrierId: user.id,
        carrierName: user.companyName || user.username,
        amount: finalAmount,
        bidType: finalBidType,
        loadPickup: load.pickupCity,
        loadDropoff: load.dropoffCity,
      });

      res.json({ success: true, bid });
    } catch (error) {
      console.error("Submit bid error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Carrier accepts fixed-price load directly - creates bid, invoice, and shipment immediately
  app.post("/api/loads/:id/accept-direct", requireAuth, async (req, res) => {
    try {
      const loadId = req.params.id;
      const user = await storage.getUser(req.session.userId!);
      
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Only carriers can accept loads" });
      }

      const { truck_id, driver_id } = req.body;

      const load = await storage.getLoad(loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      // Note: Direct accept is allowed for both fixed-price and negotiable loads
      // When a carrier accepts at the listed price, they get immediate acceptance

      // Verify load is in a state that allows acceptance
      const acceptableStatuses = ["posted_to_carriers", "open_for_bid", "priced"];
      if (!acceptableStatuses.includes(load.status || "")) {
        return res.status(400).json({ error: `Load is not available for acceptance (status: ${load.status})` });
      }

      // Use workflow service to check carrier eligibility
      const canBid = await canUserBidOnLoad(user.id, loadId);
      if (!canBid.allowed) {
        return res.status(403).json({ error: canBid.reason });
      }

      // Fleet carrier restriction: truck and driver can only be assigned to one active load at a time
      const carrierProfileForValidation = await storage.getCarrierProfile(user.id);
      const isFleetCarrier = carrierProfileForValidation?.carrierType === 'enterprise' || carrierProfileForValidation?.carrierType === 'fleet';
      
      if (isFleetCarrier) {
        const terminalStatuses = ['delivered', 'closed', 'cancelled', 'completed'];
        const carrierShipments = await storage.getShipmentsByCarrier(user.id);
        const allBids = await storage.getBidsByCarrier(user.id);
        
        // Check if truck is already assigned
        if (truck_id) {
          const truckInUse = carrierShipments.find(s => 
            s.truckId === truck_id && !terminalStatuses.includes(s.status || '')
          );
          
          if (truckInUse) {
            const activeLoad = await storage.getLoad(truckInUse.loadId);
            return res.status(400).json({ 
              error: `This truck is already assigned to an active shipment (${activeLoad?.pickupCity || 'Unknown'} to ${activeLoad?.dropoffCity || 'Unknown'}).`
            });
          }
          
          for (const b of allBids) {
            if (b.truckId === truck_id && b.status === 'accepted') {
              const bidLoad = await storage.getLoad(b.loadId);
              if (bidLoad && !terminalStatuses.includes(bidLoad.status || '')) {
                return res.status(400).json({ 
                  error: `This truck is already assigned to an accepted bid.`
                });
              }
            }
          }
        }
        
        // Check if driver is already assigned
        if (driver_id && driver_id !== 'unassigned') {
          const driverInUse = carrierShipments.find(s => 
            s.driverId === driver_id && !terminalStatuses.includes(s.status || '')
          );
          
          if (driverInUse) {
            return res.status(400).json({ 
              error: `This driver is already assigned to an active shipment.`
            });
          }
          
          for (const b of allBids) {
            if (b.driverId === driver_id && b.status === 'accepted') {
              const bidLoad = await storage.getLoad(b.loadId);
              if (bidLoad && !terminalStatuses.includes(bidLoad.status || '')) {
                return res.status(400).json({ 
                  error: `This driver is already assigned to an accepted bid.`
                });
              }
            }
          }
        }
      }

      // Get the final price from the load
      const acceptAmount = load.finalPrice || load.adminFinalPrice || "0";
      if (parseFloat(acceptAmount) <= 0) {
        return res.status(400).json({ error: "Load has no valid price set" });
      }

      // Get carrier type from profile
      const carrierProfile = await storage.getCarrierProfile(user.id);
      const carrierType = carrierProfile?.carrierType || 'enterprise';

      // Step 1: Create the bid with the fixed price
      const bid = await storage.createBid({
        loadId: loadId,
        carrierId: user.id,
        truckId: truck_id || null,
        driverId: driver_id && driver_id !== 'unassigned' ? driver_id : null,
        amount: acceptAmount,
        notes: `Direct acceptance of fixed-price load at Rs. ${parseFloat(acceptAmount).toLocaleString("en-IN")}`,
        status: 'pending',
        bidType: 'direct_acceptance',
        carrierType: carrierType,
        adminMediated: !!load.adminId,
        approvalRequired: false,
      });

      console.log(`[Direct Accept] Bid created: ${bid.id} for load ${loadId} at Rs. ${acceptAmount}`);

      // Step 2: Immediately accept the bid using workflow service
      const acceptResult = await acceptBid(bid.id, user.id, parseFloat(acceptAmount));
      
      if (!acceptResult.success) {
        console.error(`[Direct Accept] Failed to accept bid: ${acceptResult.error}`);
        return res.status(500).json({ error: acceptResult.error || "Failed to complete acceptance" });
      }

      console.log(`[Direct Accept] Bid accepted! Shipment: ${acceptResult.shipmentId}, Invoice: ${acceptResult.invoiceId}`);

      // Notify shipper
      if (load.shipperId) {
        await storage.createNotification({
          userId: load.shipperId,
          title: "Load Accepted",
          message: `${user.companyName || user.username} has accepted your load from ${load.pickupCity} to ${load.dropoffCity}. Shipment created.`,
          type: "success",
          relatedLoadId: loadId,
        });
      }

      // Notify admin
      if (load.adminId) {
        await storage.createNotification({
          userId: load.adminId,
          title: "Fixed Price Load Accepted",
          message: `${user.companyName || user.username} accepted the fixed-price load ${load.pickupCity} to ${load.dropoffCity}`,
          type: "info",
          relatedLoadId: loadId,
        });
      }

      res.json({ 
        success: true, 
        bid: acceptResult.bid || bid,
        shipmentId: acceptResult.shipmentId,
        invoiceId: acceptResult.invoiceId,
        message: "Load accepted successfully. Shipment and invoice created."
      });
    } catch (error) {
      console.error("Direct accept load error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin force-assigns carrier to load
  app.post("/api/admin/assign", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { load_id, carrier_id, truck_id, final_price } = req.body;

      const load = await storage.getLoad(load_id);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      const carrier = await storage.getUser(carrier_id);
      if (!carrier || carrier.role !== 'carrier') {
        return res.status(404).json({ error: "Carrier not found" });
      }

      // Create admin decision for assignment
      const decision = await storage.createAdminDecision({
        loadId: load_id,
        adminId: user.id,
        suggestedPrice: load.adminSuggestedPrice || final_price,
        finalPrice: final_price || load.adminFinalPrice || "0",
        postingMode: 'assign',
        comment: `Direct assignment to ${carrier.companyName || carrier.username}`,
        actionType: 'assign',
      });

      // Generate unique 4-digit pickup ID for carrier verification
      const pickupId = await storage.generateUniquePickupId();

      // Update load with canonical awarded status
      const updatedLoad = await storage.updateLoad(load_id, {
        assignedCarrierId: carrier_id,
        assignedTruckId: truck_id || null,
        adminDecisionId: decision.id,
        status: 'awarded',
        previousStatus: load.status,
        adminPostMode: 'assign',
        awardedAt: new Date(),
        statusChangedAt: new Date(),
        statusChangedBy: user.id,
        pickupId: pickupId,
      });

      // Create order/shipment
      const shipment = await storage.createShipment({
        loadId: load_id,
        carrierId: carrier_id,
        truckId: truck_id || null,
        status: 'pickup_scheduled',
      });

      // Notify carrier
      await storage.createNotification({
        userId: carrier_id,
        title: "Load Assigned to You",
        message: `You have been assigned a load from ${load.pickupCity} to ${load.dropoffCity}`,
        type: "success",
        relatedLoadId: load_id,
      });

      // Notify shipper
      await storage.createNotification({
        userId: load.shipperId,
        title: "Carrier Assigned",
        message: `${carrier.companyName || carrier.username} has been assigned to your load`,
        type: "success",
        relatedLoadId: load_id,
      });

      res.json({ success: true, load: updatedLoad, shipment, decision_id: decision.id });
    } catch (error) {
      console.error("Admin assign error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin awards a bid to a carrier
  app.post("/api/admin/award-bid", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { bid_id, truck_id } = req.body;

      const bid = await storage.getBid(bid_id);
      if (!bid) {
        return res.status(404).json({ error: "Bid not found" });
      }

      const load = await storage.getLoad(bid.loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      const carrier = await storage.getUser(bid.carrierId);
      if (!carrier) {
        return res.status(404).json({ error: "Carrier not found" });
      }

      // Update bid to accepted
      await storage.updateBid(bid_id, {
        status: 'accepted',
      });

      // Reject all other bids for this load
      const allBids = await storage.getBidsByLoad(bid.loadId);
      for (const otherBid of allBids) {
        if (otherBid.id !== bid_id && otherBid.status === 'pending') {
          await storage.updateBid(otherBid.id, { status: 'rejected' });
        }
      }

      // Generate unique 4-digit pickup ID for carrier verification
      const pickupId = await storage.generateUniquePickupId();

      // Update load to awarded status
      const updatedLoad = await storage.updateLoad(bid.loadId, {
        assignedCarrierId: bid.carrierId,
        assignedTruckId: truck_id || bid.truckId || null,
        awardedBidId: bid_id,
        status: 'awarded',
        previousStatus: load.status,
        awardedAt: new Date(),
        biddingClosedAt: new Date(),
        finalPrice: bid.amount,
        statusChangedAt: new Date(),
        statusChangedBy: user.id,
        pickupId: pickupId,
      });

      // Create shipment
      const shipment = await storage.createShipment({
        loadId: bid.loadId,
        carrierId: bid.carrierId,
        truckId: truck_id || bid.truckId || null,
        driverId: bid.driverId || null,
        status: 'pickup_scheduled',
      });

      // Notify carrier
      await storage.createNotification({
        userId: bid.carrierId,
        title: "Bid Accepted",
        message: `Your bid for the load from ${load.pickupCity} to ${load.dropoffCity} has been accepted`,
        type: "success",
        relatedLoadId: bid.loadId,
        relatedBidId: bid_id,
      });

      // Notify shipper
      await storage.createNotification({
        userId: load.shipperId,
        title: "Carrier Selected",
        message: `${carrier.companyName || carrier.username} has been awarded your load`,
        type: "success",
        relatedLoadId: bid.loadId,
      });

      res.json({ success: true, load: updatedLoad, shipment, bid });
    } catch (error) {
      console.error("Admin award bid error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin handles counter-offer (accept/reject/re-counter)
  app.post("/api/admin/counter-response", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { bid_id, action, counter_amount, notes } = req.body;

      const bid = await storage.getBid(bid_id);
      if (!bid) {
        return res.status(404).json({ error: "Bid not found" });
      }

      const load = await storage.getLoad(bid.loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      const carrier = await storage.getUser(bid.carrierId);
      if (!carrier) {
        return res.status(404).json({ error: "Carrier not found" });
      }

      if (action === 'accept') {
        // Accept the counter-offer - award the load
        await storage.updateBid(bid_id, { status: 'accepted' });

        const updatedLoad = await storage.updateLoad(bid.loadId, {
          assignedCarrierId: bid.carrierId,
          awardedBidId: bid_id,
          status: 'awarded',
          previousStatus: load.status,
          awardedAt: new Date(),
          finalPrice: bid.amount,
          statusChangedAt: new Date(),
          statusChangedBy: user.id,
        });

        await storage.createNotification({
          userId: bid.carrierId,
          title: "Counter-Offer Accepted",
          message: `Your counter-offer of Rs. ${bid.amount} has been accepted`,
          type: "success",
          relatedLoadId: bid.loadId,
          relatedBidId: bid_id,
        });

        res.json({ success: true, action: 'accepted', load: updatedLoad });
      } else if (action === 'reject') {
        // Reject the counter-offer
        await storage.updateBid(bid_id, { status: 'rejected' });

        // Check if there are other pending bids
        const allBids = await storage.getBidsByLoad(bid.loadId);
        const hasOtherPendingBids = allBids.some(b => b.id !== bid_id && b.status === 'pending');

        // Update load status back to open_for_bid if no other pending counter-offers
        if (!hasOtherPendingBids) {
          await storage.updateLoad(bid.loadId, {
            status: 'open_for_bid',
            previousStatus: load.status,
            statusChangedAt: new Date(),
          });
        }

        await storage.createNotification({
          userId: bid.carrierId,
          title: "Counter-Offer Rejected",
          message: `Your counter-offer for the ${load.pickupCity} to ${load.dropoffCity} load was not accepted`,
          type: "warning",
          relatedLoadId: bid.loadId,
          relatedBidId: bid_id,
        });

        res.json({ success: true, action: 'rejected' });
      } else if (action === 're-counter') {
        // Admin submits a re-counter offer
        await storage.updateBid(bid_id, { 
          status: 'countered',
          counterAmount: counter_amount,
        });

        // Create a new bid from admin perspective
        const adminBid = await storage.createBid({
          loadId: bid.loadId,
          carrierId: bid.carrierId, // Reference the original carrier
          amount: counter_amount,
          notes: notes || `Admin re-counter offer`,
          status: 'pending',
          bidType: 'admin_counter',
          adminMediated: true,
        });

        await storage.updateLoad(bid.loadId, {
          status: 'open_for_bid',
          previousStatus: load.status,
          statusChangedAt: new Date(),
        });

        await storage.createNotification({
          userId: bid.carrierId,
          title: "Admin Counter-Offer",
          message: `Admin has countered with Rs. ${counter_amount} for the ${load.pickupCity} to ${load.dropoffCity} load`,
          type: "info",
          relatedLoadId: bid.loadId,
          relatedBidId: adminBid.id,
        });

        res.json({ success: true, action: 're-countered', bid: adminBid });
      } else {
        return res.status(400).json({ error: "Invalid action. Use 'accept', 'reject', or 're-counter'" });
      }
    } catch (error) {
      console.error("Admin counter response error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Pricing estimation helper (auto-suggest price)
  app.post("/api/admin/estimate-price", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { distance, weight, load_type, pickup_city, dropoff_city } = req.body;

      // Pricing algorithm
      const baseRates: Record<string, number> = {
        'flatbed': 45,
        'refrigerated': 65,
        'dry_van': 40,
        'tanker': 55,
        'container': 50,
        'open_deck': 35,
        'default': 42,
      };

      const baseRate = baseRates[load_type?.toLowerCase()] || baseRates['default'];
      const distanceKm = parseFloat(distance) || 500;
      const weightTons = parseFloat(weight) || 10;

      // Base calculation: distance * rate
      let suggestedPrice = distanceKm * baseRate;

      // Weight adjustment (+2% per ton above 5 tons)
      if (weightTons > 5) {
        suggestedPrice *= (1 + (weightTons - 5) * 0.02);
      }

      // Fuel surcharge (estimated 12%)
      const fuelSurcharge = suggestedPrice * 0.12;

      // Admin margin (8%)
      const adminMargin = suggestedPrice * 0.08;

      // Handling fee
      const handlingFee = 500;

      const totalPrice = Math.round(suggestedPrice + fuelSurcharge + adminMargin + handlingFee);

      res.json({
        suggested_price: totalPrice,
        breakdown: {
          base_amount: Math.round(suggestedPrice),
          fuel_surcharge: Math.round(fuelSurcharge),
          admin_margin: Math.round(adminMargin),
          handling_fee: handlingFee,
        },
        params: {
          distance_km: distanceKm,
          weight_tons: weightTons,
          load_type: load_type || 'default',
          base_rate_per_km: baseRate,
        }
      });
    } catch (error) {
      console.error("Estimate price error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ============================================
  // Admin Pricing & Margin Builder Routes
  // ============================================

  // Pricing coefficients (configurable)
  const PRICING_CONFIG = {
    baseRates: {
      'flatbed': 45,
      'refrigerated': 65,
      'dry_van': 40,
      'tanker': 55,
      'container': 50,
      'open_deck': 35,
      'default': 42,
    } as Record<string, number>,
    fuelSurchargePercent: 12,
    defaultPlatformRate: 10,
    handlingFee: 500,
    approvalThresholdPercent: 15, // If admin price differs from suggested by > 15%, require approval
    seasonalMultipliers: {
      'jan': 1.0, 'feb': 1.0, 'mar': 1.05, 'apr': 1.05,
      'may': 1.1, 'jun': 1.1, 'jul': 1.15, 'aug': 1.1,
      'sep': 1.05, 'oct': 1.1, 'nov': 1.15, 'dec': 1.2,
    } as Record<string, number>,
    regionMultipliers: {
      'north': 1.0, 'south': 0.95, 'east': 1.02, 'west': 1.05, 'central': 1.0,
    } as Record<string, number>,
  };

  // Helper function for price calculation
  const calculatePricing = (params: {
    distance: number;
    weight: number;
    loadType?: string;
    region?: string;
    pickupDate?: Date;
  }) => {
    const { distance, weight, loadType, region, pickupDate } = params;
    const baseRate = PRICING_CONFIG.baseRates[loadType?.toLowerCase() || 'default'] || PRICING_CONFIG.baseRates['default'];
    
    // Base calculation
    let baseAmount = distance * baseRate;
    
    // Weight adjustment (+2% per ton above 5 tons)
    if (weight > 5) {
      baseAmount *= (1 + (weight - 5) * 0.02);
    }
    
    // Seasonal multiplier
    const month = (pickupDate || new Date()).toLocaleString('en-US', { month: 'short' }).toLowerCase();
    const seasonalMultiplier = PRICING_CONFIG.seasonalMultipliers[month] || 1.0;
    baseAmount *= seasonalMultiplier;
    
    // Region multiplier
    const regionMultiplier = PRICING_CONFIG.regionMultipliers[region?.toLowerCase() || 'central'] || 1.0;
    baseAmount *= regionMultiplier;
    
    // Surcharges
    const fuelSurcharge = baseAmount * (PRICING_CONFIG.fuelSurchargePercent / 100);
    const handlingFee = PRICING_CONFIG.handlingFee;
    
    const totalSuggestedPrice = Math.round(baseAmount + fuelSurcharge + handlingFee);
    
    return {
      suggestedPrice: totalSuggestedPrice,
      breakdown: {
        baseAmount: Math.round(baseAmount),
        fuelSurcharge: Math.round(fuelSurcharge),
        handlingFee,
        seasonalMultiplier,
        regionMultiplier,
      },
      params: {
        distanceKm: distance,
        weightTons: weight,
        loadType: loadType || 'default',
        baseRatePerKm: baseRate,
        region: region || 'central',
      },
      confidenceScore: Math.min(95, 70 + Math.floor(distance / 100) + (weight > 5 ? 10 : 5)),
    };
  };

  // POST /api/admin/pricing/suggest - Get suggested price with full breakdown
  app.post("/api/admin/pricing/suggest", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { load_id, distance: mockDistance, weight: mockWeight, loadType: mockLoadType, pickupCity: mockPickupCity, mockMode } = req.body;
      const load = await storage.getLoad(load_id);
      
      // In production, require load to exist unless explicit mock mode is enabled
      const isMockMode = mockMode === true || (mockDistance !== undefined && mockWeight !== undefined);
      if (!load && !isMockMode) {
        return res.status(404).json({ error: "Load not found" });
      }
      
      // Support mock data when load not found (for development with mock loads)
      const distance = load 
        ? parseFloat(load.distance?.toString() || '500') 
        : parseFloat(mockDistance?.toString() || '500');
      const weight = load 
        ? parseFloat(load.weight?.toString() || '10') 
        : parseFloat(mockWeight?.toString() || '10');
      const pickupDate = load?.pickupDate ? new Date(load.pickupDate) : new Date();
      const loadType = load?.requiredTruckType || mockLoadType;

      // Determine region from pickup city
      const city = (load?.pickupCity || mockPickupCity || '').toLowerCase();
      let region = 'central';
      if (['delhi', 'chandigarh', 'jaipur', 'lucknow'].some(c => city.includes(c))) region = 'north';
      else if (['chennai', 'bangalore', 'hyderabad', 'kochi'].some(c => city.includes(c))) region = 'south';
      else if (['kolkata', 'bhubaneswar', 'guwahati'].some(c => city.includes(c))) region = 'east';
      else if (['mumbai', 'pune', 'ahmedabad', 'surat'].some(c => city.includes(c))) region = 'west';

      const pricing = calculatePricing({
        distance,
        weight,
        loadType: loadType || undefined,
        region,
        pickupDate,
      });

      // Get comparable loads (last 90 days)
      let comparableLoads: Array<{ id: string; route: string; distance: string | number | null; finalPrice: string | null }> = [];
      if (load) {
        const allLoads = await storage.getAllLoads();
        comparableLoads = allLoads
          .filter(l => 
            l.id !== load.id && 
            l.status === 'delivered' && 
            l.finalPrice &&
            Math.abs(parseFloat(l.distance?.toString() || '0') - distance) < 100 &&
            l.requiredTruckType === load.requiredTruckType
          )
          .slice(0, 5)
          .map(l => ({
            id: l.id,
            route: `${l.pickupCity} → ${l.dropoffCity}`,
            distance: l.distance,
            finalPrice: l.finalPrice,
          }));
      }

      // Risk flags
      const riskFlags: string[] = [];
      if (load && !load.kycVerified) riskFlags.push('Shipper KYC not verified');
      if (distance > 2000) riskFlags.push('Long haul route (>2000km)');
      if (weight > 25) riskFlags.push('Heavy load (>25 tons)');

      res.json({
        load_id,
        suggested_price: pricing.suggestedPrice,
        breakdown: pricing.breakdown,
        params: pricing.params,
        confidence_score: pricing.confidenceScore,
        comparable_loads: comparableLoads,
        risk_flags: riskFlags,
        platform_rate_percent: PRICING_CONFIG.defaultPlatformRate,
      });
    } catch (error) {
      console.error("Pricing suggest error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/pricing/calculate - Calculate pricing with two-way binding
  // Given grossPrice and either platformMarginPercent OR carrierPayout, calculates the other
  app.post("/api/admin/pricing/calculate", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { grossPrice, platformMarginPercent, carrierPayout, calculateFrom } = req.body;

      // Validate grossPrice is required
      if (typeof grossPrice !== 'number' || grossPrice <= 0) {
        return res.status(400).json({ error: "grossPrice is required and must be positive" });
      }

      let result;
      if (calculateFrom === 'margin' || (platformMarginPercent !== undefined && carrierPayout === undefined)) {
        // Calculate carrier payout from margin percent
        if (typeof platformMarginPercent !== 'number') {
          return res.status(400).json({ error: "platformMarginPercent is required when calculating from margin" });
        }
        result = calculateFromMargin({ grossPrice, platformMarginPercent });
      } else if (calculateFrom === 'payout' || carrierPayout !== undefined) {
        // Calculate margin percent from carrier payout
        if (typeof carrierPayout !== 'number') {
          return res.status(400).json({ error: "carrierPayout is required when calculating from payout" });
        }
        result = calculateFromPayout({ grossPrice, carrierPayout });
      } else {
        return res.status(400).json({ 
          error: "Must provide either platformMarginPercent or carrierPayout, with calculateFrom hint" 
        });
      }

      res.json({
        success: true,
        ...result
      });
    } catch (error) {
      console.error("Pricing calculate error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/pricing/save - Save draft pricing
  app.post("/api/admin/pricing/save", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { 
        load_id, suggested_price, final_price, markup_percent, fixed_fee, 
        fuel_override, discount_amount, platform_margin_percent, notes, template_id 
      } = req.body;

      // Check if pricing already exists for this load
      let existingPricing = await storage.getAdminPricingByLoad(load_id);

      // Calculate payout and margin
      const finalPriceNum = parseFloat(final_price || suggested_price);
      const platformMarginPercent = parseFloat(platform_margin_percent || PRICING_CONFIG.defaultPlatformRate);
      const platformMargin = Math.round(finalPriceNum * (platformMarginPercent / 100));
      const payoutEstimate = Math.round(finalPriceNum - platformMargin);

      const pricingData = {
        loadId: load_id,
        adminId: user.id,
        templateId: template_id || null,
        suggestedPrice: suggested_price?.toString(),
        finalPrice: final_price?.toString() || null,
        markupPercent: markup_percent?.toString() || "0",
        fixedFee: fixed_fee?.toString() || "0",
        fuelOverride: fuel_override?.toString() || null,
        discountAmount: discount_amount?.toString() || "0",
        payoutEstimate: payoutEstimate.toString(),
        platformMargin: platformMargin.toString(),
        platformMarginPercent: platformMarginPercent.toString(),
        status: 'draft',
        notes: notes || null,
      };

      let pricing;
      if (existingPricing && existingPricing.status === 'draft') {
        pricing = await storage.updateAdminPricing(existingPricing.id, pricingData);
      } else {
        pricing = await storage.createAdminPricing(pricingData as any);
      }

      res.json({ success: true, pricing });
    } catch (error) {
      console.error("Pricing save error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/pricing/lock - Lock final price and optionally post
  app.post("/api/admin/pricing/lock", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { pricing_id, final_price, post_mode, invite_carrier_ids, notes, allow_counter_bids, advance_payment_percent } = req.body;

      const pricing = await storage.getAdminPricing(pricing_id);
      if (!pricing) {
        return res.status(404).json({ error: "Pricing not found" });
      }

      const finalPrice = parseFloat(final_price);

      // Calculate margins
      const platformMarginPercent = parseFloat(pricing.platformMarginPercent?.toString() || PRICING_CONFIG.defaultPlatformRate.toString());
      const platformMargin = Math.round(finalPrice * (platformMarginPercent / 100));
      const payoutEstimate = Math.round(finalPrice - platformMargin);

      // Update pricing record
      const updatedPricing = await storage.updateAdminPricing(pricing_id, {
        finalPrice: finalPrice.toString(),
        postMode: post_mode,
        invitedCarrierIds: invite_carrier_ids || [],
        status: 'locked',
        requiresApproval: false,
        payoutEstimate: payoutEstimate.toString(),
        platformMargin: platformMargin.toString(),
        notes: notes || pricing.notes,
      });

      // Proceed to lock and post
      const load = await storage.getLoad(pricing.loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      // Update load to 'priced' status first (canonical state machine)
      // This will transition to 'invoice_sent' after invoice is generated
      // NOTE: Do NOT overwrite advancePaymentPercent - this is the shipper's preference for invoicing
      // carrierAdvancePercent is the admin-set advance for carrier marketplace display
      // IMPORTANT: finalPrice = carrier payout (after platform margin deduction)
      // adminFinalPrice = shipper's gross price (for invoicing)
      await storage.updateLoad(pricing.loadId, {
        status: 'priced',
        previousStatus: load.status,
        adminFinalPrice: finalPrice.toString(),
        finalPrice: payoutEstimate.toString(),
        adminPostMode: post_mode,
        adminId: user.id,
        allowCounterBids: allow_counter_bids !== false,
        invitedCarrierIds: invite_carrier_ids || [],
        carrierAdvancePercent: advance_payment_percent || 0,
        priceLockedAt: new Date(),
        priceLockedBy: user.id,
        statusChangedBy: user.id,
        statusChangedAt: new Date(),
      });

      // Create admin decision record
      await storage.createAdminDecision({
        loadId: pricing.loadId,
        adminId: user.id,
        suggestedPrice: pricing.suggestedPrice,
        finalPrice: finalPrice.toString(),
        postingMode: post_mode,
        invitedCarrierIds: invite_carrier_ids || [],
        comment: notes || null,
        pricingBreakdown: JSON.stringify({
          platformMargin,
          payoutEstimate,
          markupPercent: pricing.markupPercent,
          fixedFee: pricing.fixedFee,
        }),
        actionType: 'price_and_post',
      });

      // Update pricing status to locked (not posted yet)
      await storage.updateAdminPricing(pricing_id, { status: 'locked' });

      // NOTE: Invoice is NOT created at pricing time per Admin-as-Mediator workflow
      // Invoice will be generated ONLY after carrier finalization (bid accepted)
      // This happens in acceptBid() in workflow-service.ts

      // CRITICAL FIX: Set status to 'posted_to_carriers' so carriers can see the load immediately
      // This ensures the success message in the UI is accurate - no fake success states
      // IMPORTANT: finalPrice = carrier payout, adminFinalPrice = shipper's gross price
      // carrierAdvancePercent = admin-set advance for carrier marketplace
      await storage.updateLoad(load.id, {
        status: 'posted_to_carriers',
        previousStatus: 'priced',
        adminFinalPrice: finalPrice.toString(),
        finalPrice: payoutEstimate.toString(),
        adminPostMode: post_mode,
        adminId: user.id,
        allowCounterBids: allow_counter_bids !== false,
        invitedCarrierIds: invite_carrier_ids || [],
        carrierAdvancePercent: advance_payment_percent || 0,
        postedAt: new Date(),
        statusChangedBy: user.id,
        statusChangedAt: new Date(),
      });

      // Notify shipper that load has been posted
      await storage.createNotification({
        userId: load.shipperId,
        title: "Load Posted to Carriers",
        message: `Your load from ${load.pickupCity} to ${load.dropoffCity} has been priced at Rs. ${finalPrice.toLocaleString('en-IN')} and is now visible to carriers.`,
        type: "success",
        relatedLoadId: pricing.loadId,
      });

      // Notify carriers based on post mode
      if (post_mode === 'open') {
        // For open mode, carriers will see it when they refresh the load board
      } else if (post_mode === 'invite' && invite_carrier_ids?.length > 0) {
        for (const carrierId of invite_carrier_ids) {
          await storage.createNotification({
            userId: carrierId,
            title: "Invited to Bid on Load",
            message: `You have been invited to bid on a load from ${load.pickupCity} to ${load.dropoffCity}`,
            type: "info",
            relatedLoadId: load.id,
          });
        }
      }

      // Broadcast real-time update to carrier clients - send carrier payout price
      broadcastLoadPosted({
        id: load.id,
        pickupCity: load.pickupCity,
        dropoffCity: load.dropoffCity,
        adminFinalPrice: payoutEstimate.toString(),
        requiredTruckType: load.requiredTruckType,
        status: 'posted_to_carriers',
      });

      res.json({ 
        success: true, 
        pricing: updatedPricing,
        requires_approval: false,
        load_status: 'posted_to_carriers',
        invoice_note: 'Invoice will be generated after carrier is finalized',
      });
    } catch (error) {
      console.error("Pricing lock error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/pricing/approve - Approve pricing override
  app.post("/api/admin/pricing/approve", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { pricing_id, post_mode, invite_carrier_ids, allow_counter_bids, advance_payment_percent } = req.body;

      const pricing = await storage.getAdminPricing(pricing_id);
      if (!pricing) {
        return res.status(404).json({ error: "Pricing not found" });
      }

      if (pricing.status !== 'awaiting_approval') {
        return res.status(400).json({ error: "Pricing is not awaiting approval" });
      }

      // Approve the pricing
      const approvedPricing = await storage.approveAdminPricing(pricing_id, user.id);

      // Get the load
      const load = await storage.getLoad(pricing.loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      const finalPrice = parseFloat(pricing.finalPrice?.toString() || '0');
      const mode = post_mode || pricing.postMode || 'open';
      
      // Calculate carrier payout from stored pricing
      const platformMarginPercent = parseFloat(pricing.platformMarginPercent?.toString() || '10');
      const platformMargin = Math.round(finalPrice * (platformMarginPercent / 100));
      const payoutEstimate = Math.round(finalPrice - platformMargin);

      // Set to 'posted_to_carriers' status - carriers can see the load immediately
      // NOTE: Do NOT overwrite advancePaymentPercent - this is the shipper's preference for invoicing
      // carrierAdvancePercent = admin-set advance for carrier marketplace
      // IMPORTANT: finalPrice = carrier payout, adminFinalPrice = shipper's gross price
      await storage.updateLoad(pricing.loadId, {
        status: 'posted_to_carriers',
        previousStatus: load.status,
        adminFinalPrice: finalPrice.toString(),
        finalPrice: payoutEstimate.toString(),
        adminPostMode: mode,
        adminId: pricing.adminId,
        allowCounterBids: allow_counter_bids !== false,
        invitedCarrierIds: invite_carrier_ids || pricing.invitedCarrierIds || [],
        carrierAdvancePercent: advance_payment_percent || 0,
        priceLockedAt: new Date(),
        priceLockedBy: user.id,
        postedAt: new Date(),
        statusChangedBy: user.id,
        statusChangedAt: new Date(),
      });

      // Create admin decision record
      await storage.createAdminDecision({
        loadId: pricing.loadId,
        adminId: user.id,
        suggestedPrice: pricing.suggestedPrice,
        finalPrice: finalPrice.toString(),
        postingMode: mode,
        invitedCarrierIds: invite_carrier_ids || pricing.invitedCarrierIds || [],
        comment: `Approved by ${user.username}`,
        pricingBreakdown: pricing.priceBreakdown as Record<string, unknown> || null,
        actionType: 'approve_and_post',
      });

      // Update pricing status to posted
      await storage.updateAdminPricing(pricing_id, { status: 'posted' });

      // Notify original admin
      await storage.createNotification({
        userId: pricing.adminId,
        title: "Pricing Override Approved",
        message: `Pricing approved. Load is now visible to carriers.`,
        type: "success",
        relatedLoadId: pricing.loadId,
      });

      // NOTE: Invoice is NOT created at pricing approval time per Admin-as-Mediator workflow
      // Invoice will be generated ONLY after carrier finalization (bid accepted)
      // This happens in acceptBid() in workflow-service.ts

      // Notify shipper that load is posted
      await storage.createNotification({
        userId: load.shipperId,
        title: "Load Posted to Carriers",
        message: `Your load from ${load.pickupCity} to ${load.dropoffCity} has been priced at Rs. ${finalPrice.toLocaleString('en-IN')} and is now visible to carriers.`,
        type: "success",
        relatedLoadId: pricing.loadId,
      });

      // Notify carriers based on post mode
      if (mode === 'invite' && (invite_carrier_ids || pricing.invitedCarrierIds)?.length > 0) {
        const carrierIds = invite_carrier_ids || pricing.invitedCarrierIds || [];
        for (const carrierId of carrierIds) {
          await storage.createNotification({
            userId: carrierId,
            title: "Invited to Bid on Load",
            message: `You have been invited to bid on a load from ${load.pickupCity} to ${load.dropoffCity}`,
            type: "info",
            relatedLoadId: load.id,
          });
        }
      }

      // Broadcast real-time update to carrier clients
      broadcastLoadPosted({
        id: pricing.loadId,
        pickupCity: load.pickupCity,
        dropoffCity: load.dropoffCity,
        adminFinalPrice: finalPrice.toString(),
        requiredTruckType: load.requiredTruckType,
        status: 'posted_to_carriers',
      });

      res.json({ 
        success: true, 
        pricing: approvedPricing, 
        load_status: 'posted_to_carriers',
        invoice_note: 'Invoice will be generated after carrier is finalized',
      });
    } catch (error) {
      console.error("Pricing approve error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/pricing/reject - Reject pricing override
  app.post("/api/admin/pricing/reject", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { pricing_id, reason } = req.body;

      const pricing = await storage.getAdminPricing(pricing_id);
      if (!pricing) {
        return res.status(404).json({ error: "Pricing not found" });
      }

      const rejectedPricing = await storage.rejectAdminPricing(pricing_id, user.id, reason);

      // Notify original admin
      await storage.createNotification({
        userId: pricing.adminId,
        title: "Pricing Override Rejected",
        message: `Your pricing override was rejected: ${reason}`,
        type: "error",
        relatedLoadId: pricing.loadId,
      });

      res.json({ success: true, pricing: rejectedPricing });
    } catch (error) {
      console.error("Pricing reject error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/pricing/history/:loadId - Get pricing history
  app.get("/api/admin/pricing/history/:loadId", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const history = await storage.getAdminPricingHistory(req.params.loadId);
      
      // Add admin names to history entries
      const historyWithAdmins = await Promise.all(
        history.map(async (entry) => {
          const admin = await storage.getUser(entry.adminId);
          const approver = entry.approvedBy ? await storage.getUser(entry.approvedBy) : null;
          return {
            ...entry,
            adminName: admin?.username || 'Unknown',
            approverName: approver?.username || null,
          };
        })
      );

      res.json(historyWithAdmins);
    } catch (error) {
      console.error("Pricing history error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/pricing/templates - Get all pricing templates
  app.get("/api/admin/pricing/templates", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const templates = await storage.getPricingTemplates();
      res.json(templates);
    } catch (error) {
      console.error("Get templates error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/pricing/templates - Create pricing template
  app.post("/api/admin/pricing/templates", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { name, description, markup_percent, fixed_fee, fuel_surcharge_percent, platform_rate_percent } = req.body;

      const template = await storage.createPricingTemplate({
        name,
        description,
        markupPercent: markup_percent?.toString() || "0",
        fixedFee: fixed_fee?.toString() || "0",
        fuelSurchargePercent: fuel_surcharge_percent?.toString() || "0",
        platformRatePercent: platform_rate_percent?.toString() || PRICING_CONFIG.defaultPlatformRate.toString(),
        createdBy: user.id,
      });

      res.json(template);
    } catch (error) {
      console.error("Create template error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /api/admin/pricing/templates/:id - Delete (deactivate) pricing template
  app.delete("/api/admin/pricing/templates/:id", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      await storage.deletePricingTemplate(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Delete template error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/pricing/:loadId - Get current pricing for a load
  app.get("/api/admin/pricing/:loadId", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const pricing = await storage.getAdminPricingByLoad(req.params.loadId);
      res.json(pricing || null);
    } catch (error) {
      console.error("Get pricing error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =============================================
  // INVOICE BUILDER ENDPOINTS
  // =============================================

  // GET /api/admin/invoices - Get all invoices (admin only) with enriched carrier details
  app.get("/api/admin/invoices", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const invoices = await storage.getAllInvoices();
      
      // Enrich each invoice with carrier, driver, truck, and route details
      const enrichedInvoices = await Promise.all(invoices.map(async (invoice) => {
        try {
          // Get load details for route info
          const load = await storage.getLoad(invoice.loadId);
          
          // Get shipment to find carrier and driver
          const shipment = await storage.getShipmentByLoad(invoice.loadId);
          
          let carrier = null;
          let driver = null;
          let truck = null;
          let winningBidAmount = null;
          let winningBid = null;
          
          // Get winning bid first (needed for carrier fallback)
          if (load?.awardedBidId) {
            winningBid = await storage.getBid(load.awardedBidId);
            if (winningBid) {
              // Use counterAmount if it exists (negotiated price), otherwise use original amount
              winningBidAmount = winningBid.counterAmount || winningBid.amount;
            }
          }
          
          // Try to get carrier from shipment first, then fall back to load's assigned carrier or winning bid
          let carrierId = shipment?.carrierId || load?.assignedCarrierId || winningBid?.carrierId;
          
          if (carrierId) {
            // Get carrier user info
            const carrierUser = await storage.getUser(carrierId);
            const carrierProfile = await storage.getCarrierProfile(carrierId);
            
            // Count carrier's completed trips
            const carrierShipments = await storage.getShipmentsByCarrier(carrierId);
            const tripsCompleted = carrierShipments.filter(s => s.status === 'delivered').length;
            
            if (carrierUser) {
              carrier = {
                id: carrierUser.id,
                name: carrierUser.username,
                companyName: carrierProfile?.companyName || carrierUser.companyName,
                phone: carrierUser.phone,
                carrierType: carrierProfile?.carrierType || 'solo',
                tripsCompleted,
              };
            }
          }
          
          // Get driver details (for enterprise carriers)
          if (shipment?.driverId) {
            const driverData = await storage.getDriver(shipment.driverId);
            if (driverData) {
              driver = {
                id: driverData.id,
                name: driverData.name,
                phone: driverData.phone,
                licenseNumber: driverData.licenseNumber,
              };
            }
          }
          
          // Get truck details from shipment or winning bid
          let truckId = shipment?.truckId || winningBid?.truckId;
          
          if (truckId) {
            const truckData = await storage.getTruck(truckId);
            if (truckData) {
              truck = {
                id: truckData.id,
                licensePlate: truckData.licensePlate,
                registrationNumber: truckData.registrationNumber,
                truckType: truckData.truckType,
                capacity: truckData.capacity,
                make: truckData.make,
                model: truckData.model,
              };
            }
          }
          
          // If no truck found but we have a carrier, try getting their truck directly
          if (!truck && carrierId) {
            const carrierTrucks = await storage.getTrucksByCarrier(carrierId);
            if (carrierTrucks.length > 0) {
              const carrierTruck = carrierTrucks[0]; // Get first truck for the carrier
              truck = {
                id: carrierTruck.id,
                licensePlate: carrierTruck.licensePlate,
                registrationNumber: carrierTruck.registrationNumber,
                truckType: carrierTruck.truckType,
                capacity: carrierTruck.capacity,
                make: carrierTruck.make,
                model: carrierTruck.model,
              };
            }
          }
          
          // Get shipper details
          let shipper = null;
          if (invoice.shipperId) {
            const shipperUser = await storage.getUser(invoice.shipperId);
            if (shipperUser) {
              shipper = {
                id: shipperUser.id,
                name: shipperUser.username,
                companyName: shipperUser.companyName,
                email: shipperUser.email,
                phone: shipperUser.phone,
              };
            }
          }

          return {
            ...invoice,
            pickupCity: load?.pickupCity,
            pickupAddress: load?.pickupAddress,
            dropoffCity: load?.dropoffCity,
            dropoffAddress: load?.dropoffAddress,
            loadRoute: `${load?.pickupCity || ''} to ${load?.dropoffCity || ''}`,
            shipperLoadNumber: load?.shipperLoadNumber || null,
            adminReferenceNumber: load?.adminReferenceNumber || null,
            cargoDescription: load?.goodsToBeCarried || load?.cargoDescription,
            weight: load?.weight,
            carrier,
            driver,
            truck,
            shipper,
            // Financial breakdown fields for admin view
            adminPostedPrice: load?.adminFinalPrice || load?.finalPrice,
            winningBidAmount,
            load: load ? {
              pickupCity: load.pickupCity,
              pickupAddress: load.pickupAddress,
              dropoffCity: load.dropoffCity,
              dropoffAddress: load.dropoffAddress,
              status: load.status,
              adminFinalPrice: load.adminFinalPrice,
              finalPrice: load.finalPrice,
              weight: load.weight,
              cargoDescription: load.goodsToBeCarried || load.cargoDescription,
              shipperLoadNumber: load.shipperLoadNumber,
              adminReferenceNumber: load.adminReferenceNumber,
            } : null,
          };
        } catch (err) {
          console.error(`Error enriching invoice ${invoice.id}:`, err);
          return invoice;
        }
      }));
      
      res.json(enrichedInvoices);
    } catch (error) {
      console.error("Get invoices error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/invoices/shipper - Get invoices for current shipper with enriched carrier details
  // RULE: Shipper only sees invoices AFTER they are SENT (not draft/created)
  app.get("/api/invoices/shipper", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "shipper") {
        return res.status(403).json({ error: "Shipper access required" });
      }

      const invoices = await storage.getInvoicesByShipper(user.id);
      // Filter to only show sent/approved/paid invoices (not draft/created)
      const visibleStatuses = ['sent', 'approved', 'acknowledged', 'paid', 'overdue'];
      const visibleInvoices = invoices.filter(inv => visibleStatuses.includes(inv.status || ''));
      
      // Enrich each invoice with carrier, driver, truck, and route details
      const enrichedInvoices = await Promise.all(visibleInvoices.map(async (invoice) => {
        try {
          // Get load details for route info
          const load = await storage.getLoad(invoice.loadId);
          
          // Get shipment to find carrier and driver
          const shipment = await storage.getShipmentByLoad(invoice.loadId);
          
          let carrier = null;
          let driver = null;
          let truck = null;
          let winningBid = null;
          
          // Get winning bid first (needed for carrier fallback)
          if (load?.awardedBidId) {
            winningBid = await storage.getBid(load.awardedBidId);
          }
          
          // Try to get carrier from shipment first, then fall back to load's assigned carrier or winning bid
          let carrierId = shipment?.carrierId || load?.assignedCarrierId || winningBid?.carrierId;
          
          if (carrierId) {
            // Get carrier user info
            const carrierUser = await storage.getUser(carrierId);
            const carrierProfile = await storage.getCarrierProfile(carrierId);
            
            // Count carrier's completed trips
            const carrierShipments = await storage.getShipmentsByCarrier(carrierId);
            const tripsCompleted = carrierShipments.filter(s => s.status === 'delivered').length;
            
            if (carrierUser) {
              carrier = {
                id: carrierUser.id,
                name: carrierUser.username,
                companyName: carrierProfile?.companyName || carrierUser.companyName,
                phone: carrierUser.phone,
                carrierType: carrierProfile?.carrierType || 'solo',
                tripsCompleted,
              };
            }
          }
          
          // Get driver details (for enterprise carriers)
          if (shipment?.driverId) {
            const driverData = await storage.getDriver(shipment.driverId);
            if (driverData) {
              driver = {
                id: driverData.id,
                name: driverData.name,
                phone: driverData.phone,
                licenseNumber: driverData.licenseNumber,
              };
            }
          }
          
          // Get truck details from shipment, winning bid, or carrier's truck (for solo drivers)
          let truckId = shipment?.truckId || winningBid?.truckId;
          
          if (truckId) {
            const truckData = await storage.getTruck(truckId);
            if (truckData) {
              truck = {
                id: truckData.id,
                licensePlate: truckData.licensePlate,
                registrationNumber: truckData.registrationNumber,
                truckType: truckData.truckType,
                capacity: truckData.capacity,
                make: truckData.make,
                model: truckData.model,
              };
            }
          }
          
          // If no truck found but we have a carrier, try getting their truck directly
          if (!truck && carrierId) {
            const carrierTrucks = await storage.getTrucksByCarrier(carrierId);
            if (carrierTrucks.length > 0) {
              const carrierTruck = carrierTrucks[0]; // Get first truck for the carrier
              truck = {
                id: carrierTruck.id,
                licensePlate: carrierTruck.licensePlate,
                registrationNumber: carrierTruck.registrationNumber,
                truckType: carrierTruck.truckType,
                capacity: carrierTruck.capacity,
                make: carrierTruck.make,
                model: carrierTruck.model,
              };
            }
          }
          
          // Get admin contact info for shipper support
          const admins = await storage.getAdmins();
          const primaryAdmin = admins[0];
          const adminContact = primaryAdmin ? {
            name: primaryAdmin.companyName || primaryAdmin.username || 'Load Smart Support',
            phone: primaryAdmin.phone || '+91 9876543210',
          } : {
            name: 'Load Smart Support',
            phone: '+91 9876543210',
          };

          return {
            ...invoice,
            // Full route details
            pickupCity: load?.pickupCity,
            pickupAddress: load?.pickupAddress,
            pickupLocality: load?.pickupLocality,
            pickupLandmark: load?.pickupLandmark,
            dropoffCity: load?.dropoffCity,
            dropoffAddress: load?.dropoffAddress,
            dropoffLocality: load?.dropoffLocality,
            dropoffLandmark: load?.dropoffLandmark,
            dropoffBusinessName: load?.dropoffBusinessName,
            loadRoute: `${load?.pickupCity || ''} to ${load?.dropoffCity || ''}`,
            shipperLoadNumber: load?.shipperLoadNumber || null,
            adminReferenceNumber: load?.adminReferenceNumber || null,
            cargoDescription: load?.goodsToBeCarried || load?.cargoDescription,
            weight: load?.weight,
            carrier,
            driver,
            truck,
            adminContact,
          };
        } catch (err) {
          console.error(`Error enriching invoice ${invoice.id}:`, err);
          return invoice;
        }
      }));
      
      res.json(enrichedInvoices);
    } catch (error) {
      console.error("Get shipper invoices error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/invoices/:id/confirm - Shipper confirms invoice to start carrier bidding
  app.post("/api/invoices/:id/confirm", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "shipper") {
        return res.status(403).json({ error: "Shipper access required" });
      }

      const invoice = await storage.getInvoice(req.params.id);
      if (!invoice) {
        return res.status(404).json({ error: "Invoice not found" });
      }

      // Verify shipper owns this invoice
      if (invoice.shipperId !== user.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Check if already confirmed
      if (invoice.shipperConfirmed) {
        return res.status(400).json({ error: "Invoice already confirmed" });
      }

      // Confirm the invoice (shipper approves)
      const updatedInvoice = await storage.updateInvoice(req.params.id, {
        shipperConfirmed: true,
        shipperConfirmedAt: new Date(),
        shipperResponseType: 'approve',
        status: 'approved',
        approvedAt: new Date(),
      });

      // Get the load
      const load = await storage.getLoad(invoice.loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      // NEW WORKFLOW: Invoice comes AFTER carrier finalization
      // Shipper acknowledges invoice → then pays → then transit begins
      const transitionResult = await transitionLoadState(
        load.id,
        'invoice_acknowledged',
        user.id,
        'Invoice acknowledged by shipper - awaiting payment'
      );
      if (!transitionResult.success) {
        console.warn(`Load state transition warning: ${transitionResult.error}`);
      }

      // Notify shipper of confirmation
      await storage.createNotification({
        userId: user.id,
        title: "Invoice Approved",
        message: `You have approved the invoice for ${load.pickupCity} → ${load.dropoffCity}. The shipment is ready to begin.`,
        type: "success",
        relatedLoadId: load.id,
      });

      // Notify assigned carrier that shipper approved - they can start transit
      if (load.assignedCarrierId) {
        await storage.createNotification({
          userId: load.assignedCarrierId,
          title: "Shipment Approved - Ready for Pickup",
          message: `The shipper has approved the invoice. You can now begin the shipment: ${load.pickupCity} → ${load.dropoffCity}`,
          type: "success",
          relatedLoadId: load.id,
        });

        // Create shipment now that shipper has acknowledged the invoice
        try {
          const existingShipment = await storage.getShipmentByLoad(load.id);
          if (!existingShipment) {
            // Get truck and driver from awarded bid if available
            let truckId = load.assignedTruckId;
            let driverId: string | null = null;
            if (load.awardedBidId) {
              const awardedBid = await storage.getBid(load.awardedBidId);
              if (awardedBid?.truckId && !truckId) {
                truckId = awardedBid.truckId;
              }
              if (awardedBid?.driverId) {
                driverId = awardedBid.driverId;
              }
            }

            await storage.createShipment({
              loadId: load.id,
              carrierId: load.assignedCarrierId,
              truckId: truckId || null,
              driverId: driverId,
              status: 'pickup_scheduled',
            });
          }
        } catch (shipmentError) {
          console.error("Failed to create shipment after invoice acknowledgment:", shipmentError);
        }
      }

      // Notify admins
      const allUsers = await storage.getAllUsers();
      const admins = allUsers.filter(u => u.role === 'admin');
      for (const admin of admins) {
        await storage.createNotification({
          userId: admin.id,
          title: "Shipper Approved Invoice",
          message: `Shipper ${user.companyName || user.username} approved invoice for ${load.pickupCity} → ${load.dropoffCity}. Ready for transit.`,
          type: "success",
          contextType: "invoice_paid",
          relatedLoadId: load.id,
        });
      }

      res.json({ 
        success: true, 
        invoice: updatedInvoice,
        load_status: 'invoice_acknowledged',
        message: "Invoice acknowledged. Awaiting payment to proceed.",
      });
    } catch (error) {
      console.error("Invoice confirm error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/invoices/:id/reject - Shipper rejects invoice
  app.post("/api/invoices/:id/reject", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "shipper") {
        return res.status(403).json({ error: "Shipper access required" });
      }

      const { reason } = req.body;
      if (!reason) {
        return res.status(400).json({ error: "Rejection reason is required" });
      }

      const invoice = await storage.getInvoice(req.params.id);
      if (!invoice) {
        return res.status(404).json({ error: "Invoice not found" });
      }

      if (invoice.shipperId !== user.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      if (invoice.shipperConfirmed) {
        return res.status(400).json({ error: "Invoice already confirmed" });
      }

      // Update invoice with rejection
      const updatedInvoice = await storage.updateInvoice(req.params.id, {
        shipperResponseType: 'reject',
        shipperResponseMessage: reason,
        status: 'disputed',
      });

      // Update load status to invoice_rejected (canonical state)
      const load = await storage.getLoad(invoice.loadId);
      if (load) {
        await storage.updateLoad(load.id, {
          status: 'invoice_rejected',
          previousStatus: load.status,
          statusChangedBy: user.id,
          statusChangedAt: new Date(),
          statusNote: `Invoice rejected: ${reason}`,
        });
      }

      // Create shipper invoice response record for audit
      await storage.createShipperInvoiceResponse({
        invoiceId: invoice.id,
        loadId: invoice.loadId,
        shipperId: user.id,
        responseType: 'reject',
        message: reason,
        status: 'submitted',
      });

      // Notify admins about rejection
      const allUsers = await storage.getAllUsers();
      const admins = allUsers.filter(u => u.role === 'admin');
      for (const admin of admins) {
        await storage.createNotification({
          userId: admin.id,
          title: "Invoice Rejected by Shipper",
          message: `Invoice ${invoice.invoiceNumber} was rejected: "${reason}"`,
          type: "error",
          contextType: "invoice",
          relatedLoadId: invoice.loadId,
          relatedInvoiceId: invoice.id,
        });
      }

      res.json({
        success: true,
        invoice: updatedInvoice,
        load_status: 'invoice_rejected',
        message: "Invoice rejected. Admin has been notified.",
      });
    } catch (error) {
      console.error("Invoice reject error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/invoices/:id/negotiate - Shipper requests negotiation
  app.post("/api/invoices/:id/negotiate", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "shipper") {
        return res.status(403).json({ error: "Shipper access required" });
      }

      const { proposedAmount, reason, contactName, contactCompany, contactPhone, contactAddress } = req.body;
      if (!proposedAmount || !reason) {
        return res.status(400).json({ error: "Proposed amount and reason are required" });
      }

      const invoice = await storage.getInvoice(req.params.id);
      if (!invoice) {
        return res.status(404).json({ error: "Invoice not found" });
      }

      if (invoice.shipperId !== user.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      if (invoice.shipperConfirmed) {
        return res.status(400).json({ error: "Invoice already confirmed" });
      }

      // Update invoice with negotiation request and counter contact details
      const updatedInvoice = await storage.updateInvoice(req.params.id, {
        shipperResponseType: 'negotiate',
        shipperResponseMessage: `Counter: Rs. ${parseFloat(proposedAmount).toLocaleString('en-IN')} - ${reason}`,
        shipperCounterAmount: proposedAmount.toString(),
        counterContactName: contactName || null,
        counterContactCompany: contactCompany || null,
        counterContactPhone: contactPhone || null,
        counterContactAddress: contactAddress || null,
        counterReason: reason || null,
        counteredAt: new Date(),
        counteredBy: user.id,
        status: 'disputed',
        shipperStatus: 'countered',
      });

      // Update load status to invoice_negotiation (canonical state)
      const load = await storage.getLoad(invoice.loadId);
      if (load) {
        await storage.updateLoad(load.id, {
          status: 'invoice_negotiation',
          previousStatus: load.status,
          statusChangedBy: user.id,
          statusChangedAt: new Date(),
          statusNote: `Invoice negotiation: Proposed Rs. ${proposedAmount.toLocaleString('en-IN')}`,
        });
      }

      // Create shipper invoice response record for audit
      await storage.createShipperInvoiceResponse({
        invoiceId: invoice.id,
        loadId: invoice.loadId,
        shipperId: user.id,
        responseType: 'negotiate',
        counterAmount: proposedAmount.toString(),
        message: reason,
        status: 'pending',
      });

      // Notify admins about negotiation request
      const allUsers = await storage.getAllUsers();
      const admins = allUsers.filter(u => u.role === 'admin');
      for (const admin of admins) {
        await storage.createNotification({
          userId: admin.id,
          title: "Invoice Negotiation Requested",
          message: `Shipper ${user.companyName || user.username} proposes Rs. ${parseFloat(proposedAmount).toLocaleString('en-IN')} (was Rs. ${parseFloat(invoice.totalAmount?.toString() || '0').toLocaleString('en-IN')})`,
          type: "warning",
          contextType: "invoice",
          relatedLoadId: invoice.loadId,
          relatedInvoiceId: invoice.id,
        });
      }

      res.json({
        success: true,
        invoice: updatedInvoice,
        load_status: 'invoice_negotiation',
        message: "Negotiation request submitted. Admin will review your proposal.",
      });
    } catch (error) {
      console.error("Invoice negotiate error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/invoices/:id - Get specific invoice
  app.get("/api/admin/invoices/:id", requireAuth, async (req, res) => {
    try {
      const invoice = await storage.getInvoice(req.params.id);
      if (!invoice) {
        return res.status(404).json({ error: "Invoice not found" });
      }

      const user = await storage.getUser(req.session.userId!);
      if (user?.role !== "admin" && user?.id !== invoice.shipperId) {
        return res.status(403).json({ error: "Access denied" });
      }

      res.json(invoice);
    } catch (error) {
      console.error("Get invoice error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/invoices - Create new invoice (ONLY for loads in awarded state or later)
  app.post("/api/admin/invoices", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { loadId, shipperId, lineItems, subtotal, fuelSurcharge, tollCharges, 
              handlingFee, insuranceFee, discountAmount, discountReason, 
              taxPercent, taxAmount, totalAmount, paymentTerms, dueDate, notes } = req.body;

      if (!loadId || !shipperId || !subtotal || !totalAmount) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const load = await storage.getLoad(loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      // Invoice creation allowed at awarded state (creates invoice_created) or later invoice states
      const allowedStatesForInvoice = ['awarded', 'invoice_created', 'invoice_sent', 'invoice_acknowledged', 'invoice_paid', 'in_transit', 'delivered', 'closed'];
      if (!load.status || !allowedStatesForInvoice.includes(load.status)) {
        return res.status(400).json({ 
          error: "Invoice can only be created after carrier finalization (awarded state or later)" 
        });
      }

      const invoiceNumber = await storage.generateInvoiceNumber();

      // Calculate advance payment from load
      const advancePercent = load.advancePaymentPercent || 0;
      // Sanitize totalAmount - remove commas and other formatting
      const sanitizedTotal = String(totalAmount).replace(/,/g, '').replace(/[^0-9.]/g, '');
      const totalAmountNum = parseFloat(sanitizedTotal) || parseFloat(load.adminFinalPrice || load.finalPrice || '0');
      const advanceAmount = advancePercent > 0 && !isNaN(totalAmountNum) ? (totalAmountNum * (advancePercent / 100)).toFixed(2) : null;
      const balanceOnDelivery = advancePercent > 0 && !isNaN(totalAmountNum) ? (totalAmountNum - parseFloat(advanceAmount || "0")).toFixed(2) : null;

      const invoice = await storage.createInvoice({
        invoiceNumber,
        loadId,
        shipperId,
        adminId: user.id,
        subtotal,
        fuelSurcharge: fuelSurcharge || "0",
        tollCharges: tollCharges || "0",
        handlingFee: handlingFee || "0",
        insuranceFee: insuranceFee || "0",
        discountAmount: discountAmount || "0",
        discountReason,
        taxPercent: taxPercent || "18",
        taxAmount: taxAmount || "0",
        totalAmount,
        advancePaymentPercent: advancePercent > 0 && !isNaN(totalAmountNum) ? advancePercent : null,
        advancePaymentAmount: advanceAmount,
        balanceOnDelivery: balanceOnDelivery,
        paymentTerms: paymentTerms || "Net 30",
        dueDate: dueDate ? new Date(dueDate) : undefined,
        notes,
        lineItems,
        status: "draft",
      });

      // Transition load state to invoice_created (if still in awarded state)
      if (load.status === 'awarded') {
        await storage.updateLoad(load.id, {
          status: 'invoice_created',
          previousStatus: load.status,
          statusChangedBy: user.id,
          statusChangedAt: new Date(),
          statusNote: 'Invoice created by admin',
        });
      }

      res.status(201).json(invoice);
    } catch (error) {
      console.error("Create invoice error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PUT /api/admin/invoices/:id - Update invoice
  app.put("/api/admin/invoices/:id", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const invoice = await storage.getInvoice(req.params.id);
      if (!invoice) {
        return res.status(404).json({ error: "Invoice not found" });
      }

      if (invoice.status === "paid") {
        return res.status(400).json({ error: "Cannot modify paid invoice" });
      }

      const updated = await storage.updateInvoice(req.params.id, req.body);

      // Sync price back to load when memo totalAmount changes
      if (req.body.totalAmount || req.body.subtotal) {
        try {
          const newTotal = parseFloat(req.body.totalAmount || req.body.subtotal || '0');
          if (newTotal > 0) {
            const load = await storage.getLoad(invoice.loadId);
            if (load) {
              const platformRatePercent = (load as any).platformRatePercent || 15;
              const carrierPayout = Math.round(newTotal * (1 - platformRatePercent / 100));
              await storage.updateLoad(load.id, {
                adminFinalPrice: newTotal.toString(),
                finalPrice: carrierPayout.toString(),
              });
              console.log(`[Invoice] Synced load ${load.id} price to ${newTotal} after memo update`);
            }
          }
        } catch (syncErr) {
          console.error("Error syncing load price after invoice update:", syncErr);
        }
      }

      res.json(updated);
    } catch (error) {
      console.error("Update invoice error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/invoices/:id/send - Send invoice to shipper (supports initial send and resend)
  app.post("/api/admin/invoices/:id/send", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const invoice = await storage.getInvoice(req.params.id);
      if (!invoice) {
        return res.status(404).json({ error: "Invoice not found" });
      }

      const isResend = invoice.status === 'sent';
      console.log(`[Invoice] ${isResend ? 'Resending' : 'Sending'} invoice ${invoice.invoiceNumber} (id: ${invoice.id}) to shipper ${invoice.shipperId}`);
      console.log(`[Invoice] Current status: ${invoice.status}, shipperStatus: ${invoice.shipperStatus}`);

      const updated = await storage.sendInvoice(req.params.id);
      
      if (!updated) {
        console.error(`[Invoice] CRITICAL: sendInvoice returned undefined for invoice ${invoice.id}`);
        return res.status(500).json({ error: "Failed to update invoice status" });
      }
      
      console.log(`[Invoice] Invoice ${updated.invoiceNumber} status updated: status=${updated.status}, shipperStatus=${updated.shipperStatus}`);
      
      // Transition load state to invoice_sent using centralized validation
      const load = await storage.getLoad(invoice.loadId);
      if (load) {
        const transitionResult = await transitionLoadState(
          load.id,
          'invoice_sent',
          user.id,
          isResend ? 'Invoice resent to shipper' : 'Invoice sent to shipper'
        );
        if (!transitionResult.success) {
          console.warn(`Load state transition warning: ${transitionResult.error}`);
        }
      }
      
      // Create notification for shipper (different message for resend)
      await storage.createNotification({
        userId: invoice.shipperId,
        title: isResend ? "Invoice Resent" : "New Invoice Received",
        message: `Invoice ${invoice.invoiceNumber} for load ${load?.pickupCity} to ${load?.dropoffCity} has been ${isResend ? 'resent' : 'sent'} to you.`,
        type: "invoice",
        relatedLoadId: invoice.loadId,
      });
      
      // Create shipment when invoice is first sent (not on resend)
      if (!isResend && load && load.assignedCarrierId) {
        try {
          const existingShipment = await storage.getShipmentByLoad(invoice.loadId);
          if (!existingShipment) {
            // Get driver from awarded bid if available
            let driverId: string | null = null;
            if (load.awardedBidId) {
              const awardedBid = await storage.getBid(load.awardedBidId);
              if (awardedBid?.driverId) {
                driverId = awardedBid.driverId;
              }
            }
            
            const shipment = await storage.createShipment({
              loadId: invoice.loadId,
              carrierId: load.assignedCarrierId,
              truckId: load.assignedTruckId || null,
              driverId: driverId,
              status: 'pickup_scheduled',
            });
            console.log(`[Invoice] Created shipment ${shipment.id} for load ${invoice.loadId} when invoice sent`);
            
            // Notify carrier about the shipment
            await storage.createNotification({
              userId: load.assignedCarrierId,
              title: "New Shipment Assigned",
              message: `You have a new shipment from ${load.pickupCity} to ${load.dropoffCity}. Check My Shipments for details.`,
              type: "success",
              relatedLoadId: invoice.loadId,
            });
          }
        } catch (shipmentError) {
          console.error("Failed to create shipment when sending invoice:", shipmentError);
        }
      }

      console.log(`[Invoice] Broadcasting invoice_sent event to shipper ${invoice.shipperId}`);
      broadcastInvoiceEvent(invoice.shipperId, invoice.id, "invoice_sent", updated);

      res.json(updated);
    } catch (error) {
      console.error("Send invoice error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/invoice/generate-and-send - Generate and send invoice in one step
  app.post("/api/admin/invoice/generate-and-send", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { load_id, amount } = req.body;
      if (!load_id || !amount) {
        return res.status(400).json({ error: "load_id and amount are required" });
      }

      // Get the load
      const load = await storage.getLoad(load_id);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      // Verify load is in awarded state
      if (load.status !== "awarded") {
        return res.status(400).json({ 
          error: `Load must be in 'awarded' state to generate invoice. Current state: ${load.status}` 
        });
      }

      // Get shipper info
      const shipper = await storage.getUser(load.shipperId);
      if (!shipper) {
        return res.status(404).json({ error: "Shipper not found" });
      }

      // Check if invoice already exists for this load
      const existingInvoice = await storage.getInvoiceByLoad(load_id);
      let invoice;
      
      // No GST - direct pricing as agreed
      const subtotal = parseFloat(amount);
      const gstPercent = 0;
      const taxAmount = 0;
      const totalAmount = subtotal;
      
      // Calculate advance payment from load
      const advancePercent = load.advancePaymentPercent || 0;
      const advanceAmount = advancePercent > 0 ? (totalAmount * (advancePercent / 100)).toFixed(2) : null;
      const balanceOnDelivery = advancePercent > 0 ? (totalAmount - parseFloat(advanceAmount || "0")).toFixed(2) : null;
      
      if (existingInvoice) {
        // Use existing invoice
        invoice = existingInvoice;
        // Update amounts if different
        if (parseFloat(invoice.totalAmount) !== totalAmount) {
          invoice = await storage.updateInvoice(invoice.id, { 
            subtotal: subtotal.toString(),
            taxPercent: gstPercent.toString(),
            taxAmount: taxAmount.toString(),
            totalAmount: totalAmount.toString(),
            advancePaymentPercent: advancePercent > 0 ? advancePercent : null,
            advancePaymentAmount: advanceAmount,
            balanceOnDelivery: balanceOnDelivery,
          });
        }
      } else {
        // Generate invoice number
        const allInvoices = await storage.getAllInvoices();
        const invoiceNumber = `MM-${String(allInvoices.length + 1).padStart(3, '0')}`;

        // Calculate due date (30 days from now)
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 30);

        // Create the invoice with GST included
        invoice = await storage.createInvoice({
          invoiceNumber,
          loadId: load_id,
          shipperId: load.shipperId,
          adminId: user.id,
          subtotal: subtotal.toString(),
          taxPercent: gstPercent.toString(),
          taxAmount: taxAmount.toString(),
          totalAmount: totalAmount.toString(),
          advancePaymentPercent: advancePercent > 0 ? advancePercent : null,
          advancePaymentAmount: advanceAmount,
          balanceOnDelivery: balanceOnDelivery,
          status: "draft",
          dueDate,
          lineItems: [
            {
              description: `Freight transportation: ${load.pickupCity} to ${load.dropoffCity}`,
              quantity: 1,
              unitPrice: subtotal,
              total: subtotal,
            }
          ],
          notes: `Auto-generated invoice for load ${load.id.slice(0, 8).toUpperCase()}`,
        });
      }

      // Send the invoice
      if (!invoice) {
        return res.status(500).json({ error: "Failed to create invoice" });
      }
      const sentInvoice = await storage.sendInvoice(invoice.id);
      if (!sentInvoice) {
        return res.status(500).json({ error: "Failed to send invoice" });
      }

      // Transition load state to invoice_sent
      const transitionResult = await transitionLoadState(
        load_id,
        'invoice_sent',
        user.id,
        'Invoice auto-generated and sent to shipper'
      );
      
      if (!transitionResult.success) {
        console.warn(`Load state transition warning: ${transitionResult.error}`);
      }

      // Create notification for shipper
      await storage.createNotification({
        userId: load.shipperId,
        title: "Invoice Received",
        message: `Invoice for Rs. ${totalAmount.toLocaleString('en-IN')} has been generated for your load from ${load.pickupCity} to ${load.dropoffCity}.`,
        type: "invoice",
        relatedLoadId: load_id,
      });

      // Broadcast invoice event
      broadcastInvoiceEvent(load.shipperId, invoice.id, "invoice_sent", sentInvoice);

      // Audit log
      await storage.createAuditLog({
        adminId: user.id,
        loadId: load_id,
        actionType: 'generate_and_send_invoice',
        actionDescription: `Generated and sent invoice ${invoice?.invoiceNumber} for Rs. ${amount}`,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      res.json({ 
        success: true, 
        invoice: sentInvoice,
        message: `Invoice ${invoice?.invoiceNumber} generated and sent to shipper`
      });
    } catch (error) {
      console.error("Generate and send invoice error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/invoices/:id/pay - Mark invoice as paid
  app.post("/api/admin/invoices/:id/pay", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { paidAmount, paymentMethod, paymentReference } = req.body;
      if (!paidAmount || !paymentMethod) {
        return res.status(400).json({ error: "Missing payment details" });
      }

      const invoice = await storage.getInvoice(req.params.id);
      if (!invoice) {
        return res.status(404).json({ error: "Invoice not found" });
      }

      const updated = await storage.markInvoicePaid(req.params.id, {
        paidAmount,
        paymentMethod,
        paymentReference,
      });

      // Transition load state to invoice_paid using centralized validation
      const load = await storage.getLoad(invoice.loadId);
      if (load) {
        const transitionResult = await transitionLoadState(
          load.id,
          'invoice_paid',
          user.id,
          'Invoice paid - ready for transit'
        );
        if (!transitionResult.success) {
          console.warn(`Load state transition warning: ${transitionResult.error}`);
        }

        // Notify carrier that payment is complete and they can begin
        if (load.assignedCarrierId) {
          await storage.createNotification({
            userId: load.assignedCarrierId,
            title: "Payment Received - Ready for Pickup",
            message: `Payment confirmed for ${load.pickupCity} → ${load.dropoffCity}. You can now schedule pickup.`,
            type: "success",
            relatedLoadId: load.id,
          });
        }
      }

      res.json(updated);
    } catch (error) {
      console.error("Mark invoice paid error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/invoices/:id/mark-paid - Admin marks invoice as paid (simplified version)
  app.post("/api/admin/invoices/:id/mark-paid", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const invoice = await storage.getInvoice(req.params.id);
      if (!invoice) {
        return res.status(404).json({ error: "Invoice not found" });
      }

      // Mark invoice as paid with default values
      const updated = await storage.markInvoicePaid(req.params.id, {
        paidAmount: invoice.totalAmount,
        paymentMethod: "manual_admin",
        paymentReference: `ADMIN-${Date.now()}`,
      });

      // Transition load state to invoice_paid
      const load = await storage.getLoad(invoice.loadId);
      if (load) {
        const transitionResult = await transitionLoadState(
          load.id,
          'invoice_paid',
          user.id,
          'Invoice marked as paid by admin'
        );
        if (!transitionResult.success) {
          console.warn(`Load state transition warning: ${transitionResult.error}`);
        }

        // Notify carrier that payment is complete
        if (load.assignedCarrierId) {
          await storage.createNotification({
            userId: load.assignedCarrierId,
            title: "Payment Received - Ready for Pickup",
            message: `Payment confirmed for ${load.pickupCity} → ${load.dropoffCity}. You can now schedule pickup.`,
            type: "success",
            relatedLoadId: load.id,
          });
        }

        // Notify shipper about payment confirmation
        await storage.createNotification({
          userId: load.shipperId,
          title: "Payment Confirmed",
          message: `Your payment for invoice ${invoice.invoiceNumber} has been confirmed.`,
          type: "success",
          relatedLoadId: load.id,
        });
      }

      // Broadcast invoice event
      broadcastInvoiceEvent(invoice.shipperId, invoice.id, "invoice_paid", updated);

      // Audit log
      await storage.createAuditLog({
        adminId: user.id,
        loadId: invoice.loadId,
        actionType: 'mark_invoice_paid',
        actionDescription: `Marked invoice ${invoice.invoiceNumber} as paid`,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      res.json(updated);
    } catch (error) {
      console.error("Admin mark invoice paid error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/invoices/load/:loadId - Get invoice for a specific load
  app.get("/api/admin/invoices/load/:loadId", requireAuth, async (req, res) => {
    try {
      const invoice = await storage.getInvoiceByLoad(req.params.loadId);
      res.json(invoice || null);
    } catch (error) {
      console.error("Get invoice by load error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/invoices/generate - Generate invoice from Invoice Builder (ONLY for awarded+ loads)
  app.post("/api/admin/invoices/generate", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { loadId, shipperId, lineItems, subtotal, discountAmount, discountReason,
              taxPercent, taxAmount, totalAmount, paymentTerms, dueDate, notes,
              platformMargin, estimatedCarrierPayout, status, sendToShipper, idempotencyKey } = req.body;

      // CRITICAL: Verify load is in awarded state or later before allowing invoice creation
      const load = await storage.getLoad(loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      // Invoice creation allowed at awarded state (creates invoice_created) or later invoice states
      const allowedStatesForInvoice = ['awarded', 'invoice_created', 'invoice_sent', 'invoice_acknowledged', 'invoice_paid', 'in_transit', 'delivered', 'closed'];
      if (!load.status || !allowedStatesForInvoice.includes(load.status)) {
        return res.status(400).json({ 
          error: "Invoice can only be created after carrier finalization (awarded state or later)" 
        });
      }

      // Check idempotency
      if (idempotencyKey) {
        const existing = await storage.getInvoiceByIdempotencyKey(idempotencyKey);
        if (existing) {
          return res.json({ invoice: existing, existed: true });
        }
      }

      // Check if invoice already exists for this load
      const existingInvoice = await storage.getInvoiceByLoad(loadId);
      if (existingInvoice) {
        return res.json({ invoice: existingInvoice, existed: true });
      }

      if (!loadId || !shipperId || !subtotal || !totalAmount) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const invoiceNumber = await storage.generateInvoiceNumber();
      const dueDateValue = dueDate ? new Date(dueDate) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      // Calculate advance payment from load
      const advancePercent = load.advancePaymentPercent || 0;
      // Sanitize totalAmount - remove commas and other formatting
      const sanitizedTotal = String(totalAmount).replace(/,/g, '').replace(/[^0-9.]/g, '');
      const totalAmountNum = parseFloat(sanitizedTotal) || parseFloat(load.adminFinalPrice || load.finalPrice || '0');
      const advanceAmount = advancePercent > 0 && !isNaN(totalAmountNum) ? (totalAmountNum * (advancePercent / 100)).toFixed(2) : null;
      const balanceOnDelivery = advancePercent > 0 && !isNaN(totalAmountNum) ? (totalAmountNum - parseFloat(advanceAmount || "0")).toFixed(2) : null;

      const invoice = await storage.createInvoice({
        invoiceNumber,
        loadId,
        shipperId,
        adminId: user.id,
        subtotal,
        discountAmount: discountAmount || "0",
        discountReason,
        taxPercent: taxPercent || "18",
        taxAmount: taxAmount || "0",
        totalAmount,
        advancePaymentPercent: advancePercent > 0 && !isNaN(totalAmountNum) ? advancePercent : null,
        advancePaymentAmount: advanceAmount,
        balanceOnDelivery: balanceOnDelivery,
        paymentTerms: paymentTerms || "Net 30",
        dueDate: dueDateValue,
        notes,
        lineItems,
        platformMargin: platformMargin || "0",
        estimatedCarrierPayout: estimatedCarrierPayout || "0",
        status: status || "draft",
        idempotencyKey,
      });

      // Transition load state to invoice_created (if still in awarded state)
      if (load.status === 'awarded') {
        await storage.updateLoad(load.id, {
          status: 'invoice_created',
          previousStatus: load.status,
          statusChangedBy: user.id,
          statusChangedAt: new Date(),
          statusNote: 'Invoice created by admin',
        });
      }

      // Create audit log
      await storage.createInvoiceHistory({
        invoiceId: invoice.id,
        userId: user.id,
        action: "create",
        payload: { lineItems, subtotal, totalAmount, taxPercent },
      });

      // If sendToShipper is true, send immediately
      if (sendToShipper) {
        await storage.updateInvoice(invoice.id, { status: "sent", sentAt: new Date() });
        
        // Transition load state to invoice_sent
        await storage.updateLoad(load.id, {
          status: 'invoice_sent',
          previousStatus: 'invoice_created',
          statusChangedBy: user.id,
          statusChangedAt: new Date(),
          statusNote: 'Invoice sent to shipper',
        });
        
        await storage.createNotification({
          userId: shipperId,
          title: "Invoice Received",
          message: `Invoice ${invoiceNumber} for ${load?.pickupCity} to ${load?.dropoffCity} - Total: Rs. ${parseFloat(totalAmount).toLocaleString('en-IN')}`,
          type: "invoice",
          relatedLoadId: loadId,
        });

        await storage.createInvoiceHistory({
          invoiceId: invoice.id,
          userId: user.id,
          action: "send",
          payload: { sentAt: new Date() },
        });
      }

      res.status(201).json({ invoice, existed: false });
    } catch (error) {
      console.error("Generate invoice error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/invoices/:id/history - Get invoice audit history
  app.get("/api/admin/invoices/:id/history", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const history = await storage.getInvoiceHistory(req.params.id);
      res.json(history);
    } catch (error) {
      console.error("Get invoice history error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/shipper/invoices/:id/acknowledge - Shipper acknowledges invoice
  app.post("/api/shipper/invoices/:id/acknowledge", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "shipper") {
        return res.status(403).json({ error: "Shipper access required" });
      }

      const invoice = await storage.getInvoice(req.params.id);
      if (!invoice || invoice.shipperId !== user.id) {
        return res.status(404).json({ error: "Invoice not found" });
      }

      const updated = await storage.updateInvoice(req.params.id, {
        status: "acknowledged",
        shipperStatus: "acknowledged",
        viewedAt: new Date(),
        // acknowledgedAt: new Date(), // Field removed from schema or not available
      });

      // Transition load state to invoice_acknowledged using centralized validation
      const transitionResult = await transitionLoadState(
        invoice.loadId,
        'invoice_acknowledged',
        user.id,
        'Invoice acknowledged by shipper'
      );
      if (!transitionResult.success) {
        console.warn(`Load state transition warning: ${transitionResult.error}`);
      }

      await storage.createInvoiceHistory({
        invoiceId: invoice.id,
        userId: user.id,
        action: "acknowledge",
        payload: { acknowledgedAt: new Date() },
      });

      // Notify admin
      const admins = (await storage.getAllUsers()).filter(u => u.role === 'admin');
      for (const admin of admins) {
        await storage.createNotification({
          userId: admin.id,
          title: "Invoice Acknowledged",
          message: `${user.companyName || user.username} acknowledged invoice ${invoice.invoiceNumber}`,
          type: "success",
          contextType: "invoice_acknowledged",
          relatedLoadId: invoice.loadId,
          relatedInvoiceId: invoice.id,
        });
      }

      broadcastInvoiceEvent(invoice.shipperId, invoice.id, "invoice_acknowledged", updated);

      res.json(updated);
    } catch (error) {
      console.error("Acknowledge invoice error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/shipper/invoices/:id/view - Track when shipper first views invoice
  app.post("/api/shipper/invoices/:id/view", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "shipper") {
        return res.status(403).json({ error: "Shipper access required" });
      }

      const invoice = await storage.getInvoice(req.params.id);
      if (!invoice || invoice.shipperId !== user.id) {
        return res.status(404).json({ error: "Invoice not found" });
      }

      // Only update if not already viewed
      if (!invoice.viewedAt && invoice.shipperStatus === "pending") {
        const updated = await storage.updateInvoice(req.params.id, {
          viewedAt: new Date(),
          shipperStatus: "viewed",
        });

        await storage.createInvoiceHistory({
          invoiceId: invoice.id,
          userId: user.id,
          action: "view",
          payload: { viewedAt: new Date() },
        });

        // Broadcast to admin for real-time tracking
        broadcastInvoiceEvent(invoice.shipperId, invoice.id, "invoice_viewed", updated);

        res.json({ ...updated, firstView: true });
      } else {
        res.json({ ...invoice, firstView: false });
      }
    } catch (error) {
      console.error("View invoice error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/shipper/invoices/:id/pay - Shipper pays invoice (mock)
  app.post("/api/shipper/invoices/:id/pay", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "shipper") {
        return res.status(403).json({ error: "Shipper access required" });
      }

      const invoice = await storage.getInvoice(req.params.id);
      if (!invoice || invoice.shipperId !== user.id) {
        return res.status(404).json({ error: "Invoice not found" });
      }

      const { paymentMethod } = req.body;
      const paymentReference = `PAY-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

      const updated = await storage.markInvoicePaid(req.params.id, {
        paidAmount: invoice.totalAmount,
        paymentMethod: paymentMethod || "mock_payment",
        paymentReference,
      });

      // Transition load state to invoice_paid using centralized validation
      const transitionResult = await transitionLoadState(
        invoice.loadId,
        'invoice_paid',
        user.id,
        'Invoice paid by shipper - ready for transit'
      );
      if (!transitionResult.success) {
        console.warn(`Load state transition warning: ${transitionResult.error}`);
      }

      await storage.createInvoiceHistory({
        invoiceId: invoice.id,
        userId: user.id,
        action: "pay",
        payload: { paymentMethod, paymentReference, paidAmount: invoice.totalAmount },
      });

      // Notify admin
      const admins = (await storage.getAllUsers()).filter(u => u.role === 'admin');
      for (const admin of admins) {
        await storage.createNotification({
          userId: admin.id,
          title: "Payment Received",
          message: `Payment of Rs. ${parseFloat(invoice.totalAmount).toLocaleString('en-IN')} received for invoice ${invoice.invoiceNumber}`,
          type: "success",
          contextType: "invoice_paid",
          relatedLoadId: invoice.loadId,
          relatedInvoiceId: invoice.id,
        });
      }

      // Notify carrier that payment is complete and they can begin transit
      const load = await storage.getLoad(invoice.loadId);
      if (load?.assignedCarrierId) {
        await storage.createNotification({
          userId: load.assignedCarrierId,
          title: "Payment Received - Ready for Pickup",
          message: `Payment confirmed for ${load.pickupCity} → ${load.dropoffCity}. You can now schedule pickup.`,
          type: "success",
          relatedLoadId: load.id,
        });
      }

      broadcastInvoiceEvent(invoice.shipperId, invoice.id, "invoice_paid", updated);

      res.json({ invoice: updated, paymentReference });
    } catch (error) {
      console.error("Pay invoice error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/shipper/invoices/:id/query - Shipper raises a query/dispute
  app.post("/api/shipper/invoices/:id/query", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "shipper") {
        return res.status(403).json({ error: "Shipper access required" });
      }

      const invoice = await storage.getInvoice(req.params.id);
      if (!invoice || invoice.shipperId !== user.id) {
        return res.status(404).json({ error: "Invoice not found" });
      }

      const { message } = req.body;
      if (!message) {
        return res.status(400).json({ error: "Query message is required" });
      }

      const updated = await storage.updateInvoice(req.params.id, {
        status: "disputed",
      });

      await storage.createInvoiceHistory({
        invoiceId: invoice.id,
        userId: user.id,
        action: "dispute",
        payload: { message, disputedAt: new Date() },
      });

      // Notify admin
      const admins = (await storage.getAllUsers()).filter(u => u.role === 'admin');
      for (const admin of admins) {
        await storage.createNotification({
          userId: admin.id,
          title: "Invoice Query Raised",
          message: `${user.companyName || user.username} raised a query on invoice ${invoice.invoiceNumber}: "${message.slice(0, 50)}..."`,
          type: "warning",
          contextType: "invoice",
          relatedLoadId: invoice.loadId,
          relatedInvoiceId: invoice.id,
        });
      }

      res.json({ invoice: updated, queryId: `QRY-${Date.now()}` });
    } catch (error) {
      console.error("Query invoice error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/shipper/invoices/:id/negotiate - Shipper submits counter offer
  app.post("/api/shipper/invoices/:id/negotiate", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "shipper") {
        return res.status(403).json({ error: "Shipper access required" });
      }

      const { proposedAmount, reason, contactName, contactCompany, contactPhone, contactAddress } = req.body;
      if (!proposedAmount || !reason) {
        return res.status(400).json({ error: "Proposed amount and reason are required" });
      }

      const invoice = await storage.getInvoice(req.params.id);
      if (!invoice) {
        return res.status(404).json({ error: "Invoice not found" });
      }

      if (invoice.shipperId !== user.id) {
        return res.status(403).json({ error: "Access denied" });
      }

      if (invoice.shipperConfirmed) {
        return res.status(400).json({ error: "Invoice already confirmed" });
      }

      // Update invoice with negotiation request and counter contact details
      const updatedInvoice = await storage.updateInvoice(req.params.id, {
        shipperResponseType: 'negotiate',
        shipperResponseMessage: `Counter: Rs. ${parseFloat(proposedAmount).toLocaleString('en-IN')} - ${reason}`,
        shipperCounterAmount: proposedAmount.toString(),
        counterContactName: contactName || null,
        counterContactCompany: contactCompany || null,
        counterContactPhone: contactPhone || null,
        counterContactAddress: contactAddress || null,
        counterReason: reason || null,
        counteredAt: new Date(),
        counteredBy: user.id,
        status: 'disputed',
        shipperStatus: 'countered',
      });

      // Update load status to invoice_negotiation (canonical state)
      const load = await storage.getLoad(invoice.loadId);
      if (load) {
        await storage.updateLoad(load.id, {
          status: 'invoice_negotiation',
          previousStatus: load.status,
          statusChangedBy: user.id,
          statusChangedAt: new Date(),
          statusNote: `Invoice negotiation: Proposed Rs. ${proposedAmount.toLocaleString('en-IN')}`,
        });
      }

      // Create shipper invoice response record for audit
      await storage.createShipperInvoiceResponse({
        invoiceId: invoice.id,
        loadId: invoice.loadId,
        shipperId: user.id,
        responseType: 'negotiate',
        counterAmount: proposedAmount.toString(),
        message: reason,
        status: 'pending',
      });

      // Notify admins about negotiation request
      const allUsers = await storage.getAllUsers();
      const admins = allUsers.filter(u => u.role === 'admin');
      for (const admin of admins) {
        await storage.createNotification({
          userId: admin.id,
          title: "Invoice Counter Offer Received",
          message: `Shipper ${user.companyName || user.username} proposes Rs. ${parseFloat(proposedAmount).toLocaleString('en-IN')} (was Rs. ${parseFloat(invoice.totalAmount?.toString() || '0').toLocaleString('en-IN')})`,
          type: "warning",
          contextType: "invoice",
          relatedLoadId: invoice.loadId,
          relatedInvoiceId: invoice.id,
        });
      }

      // Broadcast real-time update
      broadcastInvoiceEvent(invoice.shipperId, invoice.id, "invoice_countered", updatedInvoice);

      res.json({
        success: true,
        invoice: updatedInvoice,
        load_status: 'invoice_negotiation',
        message: "Counter offer submitted. Admin will review your proposal.",
      });
    } catch (error) {
      console.error("Shipper invoice negotiate error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =============================================
  // CARRIER PROPOSAL ENDPOINTS (Edited Estimations)
  // =============================================

  // POST /api/admin/proposals/send - Send edited estimation to carriers
  app.post("/api/admin/proposals/send", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { loadId, carrierIds, proposedPayout, lineItems, message, expiryHours } = req.body;

      if (!loadId || !carrierIds?.length || !proposedPayout) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const load = await storage.getLoad(loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      const expiresAt = new Date(Date.now() + (expiryHours || 24) * 60 * 60 * 1000);
      const proposals = [];

      for (const carrierId of carrierIds) {
        const proposal = await storage.createCarrierProposal({
          loadId,
          carrierId,
          adminId: user.id,
          proposedPayout,
          lineItems,
          message,
          expiresAt,
          status: "pending",
        });
        proposals.push(proposal);

        // Notify carrier
        await storage.createNotification({
          userId: carrierId,
          title: "New Proposal Received",
          message: `You have a new freight proposal for ${load.pickupCity} to ${load.dropoffCity} - Payout: Rs. ${parseFloat(proposedPayout).toLocaleString('en-IN')}`,
          type: "info",
          relatedLoadId: loadId,
        });
      }

      res.json({ proposals, count: proposals.length });
    } catch (error) {
      console.error("Send proposals error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/carrier/proposals - Get proposals for carrier
  app.get("/api/carrier/proposals", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      const proposals = await storage.getCarrierProposalsByCarrier(user.id);
      res.json(proposals);
    } catch (error) {
      console.error("Get proposals error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/carrier/proposals/pending - Get pending proposals for carrier
  app.get("/api/carrier/proposals/pending", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      const proposals = await storage.getPendingCarrierProposals(user.id);
      res.json(proposals);
    } catch (error) {
      console.error("Get pending proposals error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/carrier/proposals/:id/accept - Accept a proposal
  app.post("/api/carrier/proposals/:id/accept", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      const proposal = await storage.getCarrierProposal(req.params.id);
      if (!proposal || proposal.carrierId !== user.id) {
        return res.status(404).json({ error: "Proposal not found" });
      }

      if (proposal.status !== "pending") {
        return res.status(400).json({ error: "Proposal is no longer pending" });
      }

      if (proposal.expiresAt && new Date(proposal.expiresAt) < new Date()) {
        await storage.updateCarrierProposal(req.params.id, { status: "expired" });
        return res.status(400).json({ error: "Proposal has expired" });
      }

      const updated = await storage.acceptCarrierProposal(req.params.id);

      // Notify admin
      await storage.createNotification({
        userId: proposal.adminId,
        title: "Proposal Accepted",
        message: `${user.companyName || user.username} accepted your proposal for payout Rs. ${parseFloat(proposal.proposedPayout).toLocaleString('en-IN')}`,
        type: "success",
        contextType: "invoice_paid",
        relatedLoadId: proposal.loadId,
      });

      res.json(updated);
    } catch (error) {
      console.error("Accept proposal error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/carrier/proposals/:id/counter - Counter a proposal
  app.post("/api/carrier/proposals/:id/counter", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      const proposal = await storage.getCarrierProposal(req.params.id);
      if (!proposal || proposal.carrierId !== user.id) {
        return res.status(404).json({ error: "Proposal not found" });
      }

      if (proposal.status !== "pending") {
        return res.status(400).json({ error: "Proposal is no longer pending" });
      }

      const { counterAmount, counterMessage } = req.body;
      if (!counterAmount) {
        return res.status(400).json({ error: "Counter amount is required" });
      }

      const updated = await storage.counterCarrierProposal(
        req.params.id,
        counterAmount,
        counterMessage || ""
      );

      // Notify admin
      await storage.createNotification({
        userId: proposal.adminId,
        title: "Counter Offer Received",
        message: `${user.companyName || user.username} countered with Rs. ${parseFloat(counterAmount).toLocaleString('en-IN')}`,
        type: "warning",
        contextType: "counter_offer",
        relatedLoadId: proposal.loadId,
      });

      res.json(updated);
    } catch (error) {
      console.error("Counter proposal error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/proposals/load/:loadId - Get proposals for a load
  app.get("/api/admin/proposals/load/:loadId", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const proposals = await storage.getCarrierProposalsByLoad(req.params.loadId);
      res.json(proposals);
    } catch (error) {
      console.error("Get proposals by load error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =============================================
  // CARRIER SETTLEMENT ENDPOINTS
  // =============================================

  // GET /api/carrier/settlements - Get settlements for current carrier
  app.get("/api/carrier/settlements", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      const settlements = await storage.getSettlementsByCarrier(user.id);
      res.json(settlements);
    } catch (error) {
      console.error("Get carrier settlements error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/carrier/dashboard/stats - Get carrier dashboard statistics
  app.get("/api/carrier/dashboard/stats", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      // Get carrier's shipments
      const allShipments = await storage.getShipmentsByCarrier(user.id);
      
      // Get carrier's bids
      const allBids = await storage.getBidsByCarrier(user.id);
      
      // Get carrier's trucks
      const allTrucks = await storage.getTrucksByCarrier(user.id);
      
      // Get carrier's settlements
      const settlements = await storage.getSettlementsByCarrier(user.id);

      // Calculate stats
      const activeStatuses = ['in_transit', 'picked_up', 'out_for_delivery', 'at_checkpoint', 'pickup_scheduled', 'assigned'];
      const activeShipments = allShipments.filter(s => activeStatuses.includes(s.status || ''));
      
      // Active trucks - those assigned to active shipments
      // For solo drivers (1 truck), if they have active shipments, count the truck as active
      let activeTruckCount = 0;
      if (allTrucks.length === 1 && activeShipments.length > 0) {
        // Solo driver with active shipments - their truck is active
        activeTruckCount = 1;
      } else {
        // Fleet carrier - count trucks with truckId in shipments
        const activeTruckIds = new Set(activeShipments.map(s => s.truckId).filter(Boolean));
        activeTruckCount = activeTruckIds.size;
      }
      
      // Available trucks - for solo drivers, if they have active shipments, truck is not available
      let availableTruckCount = 0;
      if (allTrucks.length === 1) {
        // Solo driver - truck is available only if no active shipments
        availableTruckCount = activeShipments.length === 0 ? 1 : 0;
      } else {
        // Fleet carrier - count trucks marked as available
        availableTruckCount = allTrucks.filter(t => t.isAvailable === true).length;
      }
      
      // Pending bids
      const pendingBidsCount = allBids.filter(b => b.status === "pending" || b.status === "countered").length;
      
      // Active trips count
      const activeTripsCount = activeShipments.length;
      
      // Drivers en route (in_transit only)
      const driversEnRoute = allShipments.filter(s => s.status === "in_transit").length;
      
      // Monthly revenue from paid settlements
      const now = new Date();
      const currentMonth = now.getMonth();
      const currentYear = now.getFullYear();
      
      const currentMonthSettlements = settlements.filter((s: any) => {
        if (s.status !== 'paid' || !s.paidAt) return false;
        const paidDate = new Date(s.paidAt);
        return paidDate.getMonth() === currentMonth && paidDate.getFullYear() === currentYear;
      });
      
      const currentMonthRevenue = currentMonthSettlements.reduce(
        (sum: number, s: any) => sum + parseFloat(s.carrierPayoutAmount?.toString() || s.netPayout?.toString() || '0'), 
        0
      );
      
      // Calculate revenue from completed shipments if no settlements exist
      // Use invoice data from completed deliveries (field is completedAt, not deliveredAt)
      let calculatedRevenue = currentMonthRevenue;
      if (calculatedRevenue === 0) {
        const completedShipments = allShipments.filter(s => 
          s.status === 'delivered' && s.completedAt
        );
        
        for (const shipment of completedShipments) {
          const completedDate = new Date(shipment.completedAt!);
          if (completedDate.getMonth() === currentMonth && completedDate.getFullYear() === currentYear) {
            const load = await storage.getLoad(shipment.loadId);
            if (load && load.adminFinalPrice) {
              // Estimate carrier payout as 85% of load price (15% platform fee)
              calculatedRevenue += parseFloat(load.adminFinalPrice) * 0.85;
            }
          }
        }
      }
      
      // Completed trips this month
      const completedTripsThisMonth = allShipments.filter(s => {
        if (s.status !== 'delivered' || !s.completedAt) return false;
        const completedDate = new Date(s.completedAt);
        return completedDate.getMonth() === currentMonth && completedDate.getFullYear() === currentYear;
      }).length;

      res.json({
        activeTruckCount,
        totalTruckCount: allTrucks.length,
        availableTruckCount,
        pendingBidsCount,
        activeTripsCount,
        driversEnRoute,
        currentMonthRevenue: calculatedRevenue,
        completedTripsThisMonth,
        totalShipments: allShipments.length,
        hasRevenueData: calculatedRevenue > 0 || currentMonthSettlements.length > 0,
      });
    } catch (error) {
      console.error("Get carrier dashboard stats error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/carrier/performance - Get carrier performance metrics from real trip history
  app.get("/api/carrier/performance", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      // Get all completed shipments for this carrier (delivered status)
      const allShipments = await storage.getShipmentsByCarrier(user.id);
      const completedShipments = allShipments.filter(s => 
        s.status === 'delivered' && s.completedAt
      );

      // Get all ratings received by this carrier
      const allRatings = await db
        .select()
        .from(ratings)
        .where(eq(ratings.ratedUserId, user.id));

      // If no completed trips, return null metrics
      if (completedShipments.length === 0) {
        return res.json({
          hasData: false,
          totalTrips: 0,
          overallScore: null,
          reliabilityScore: null,
          communicationScore: null,
          onTimeRate: null,
          tripHistory: []
        });
      }

      // Calculate on-time delivery rate
      let onTimeCount = 0;
      const tripHistory: Array<{
        tripId: string;
        loadId: string;
        completedAt: Date;
        wasOnTime: boolean;
        rating: { reliability: number; communication: number; onTimeDelivery: number } | null;
      }> = [];

      for (const shipment of completedShipments) {
        // Check if delivery was on time (completedAt <= eta)
        const wasOnTime = shipment.eta 
          ? new Date(shipment.completedAt!) <= new Date(shipment.eta)
          : true; // If no ETA set, assume on-time
        
        if (wasOnTime) onTimeCount++;

        // Find rating for this load
        const loadRating = allRatings.find(r => r.loadId === shipment.loadId);

        tripHistory.push({
          tripId: shipment.id,
          loadId: shipment.loadId,
          completedAt: shipment.completedAt!,
          wasOnTime,
          rating: loadRating ? {
            reliability: loadRating.reliability,
            communication: loadRating.communication,
            onTimeDelivery: loadRating.onTimeDelivery
          } : null
        });
      }

      const onTimeRate = Math.round((onTimeCount / completedShipments.length) * 100);

      // Calculate average ratings from received reviews
      let avgReliability = 0;
      let avgCommunication = 0;
      let avgOnTimeRating = 0;

      if (allRatings.length > 0) {
        avgReliability = allRatings.reduce((sum, r) => sum + r.reliability, 0) / allRatings.length;
        avgCommunication = allRatings.reduce((sum, r) => sum + r.communication, 0) / allRatings.length;
        avgOnTimeRating = allRatings.reduce((sum, r) => sum + r.onTimeDelivery, 0) / allRatings.length;
      } else {
        // If no ratings yet, use calculated on-time rate to estimate (scale 1-5)
        avgReliability = 4.0; // Default baseline
        avgCommunication = 4.0; // Default baseline
        avgOnTimeRating = (onTimeRate / 100) * 5;
      }

      // Calculate overall score (weighted average, out of 5)
      // Weights: Reliability 40%, On-Time 30%, Communication 30%
      const overallScore = (avgReliability * 0.4) + (avgOnTimeRating * 0.3) + (avgCommunication * 0.3);

      // Sort trip history by completion date (most recent first)
      tripHistory.sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());

      res.json({
        hasData: true,
        totalTrips: completedShipments.length,
        overallScore: Math.round(overallScore * 10) / 10,
        reliabilityScore: Math.round(avgReliability * 10) / 10,
        communicationScore: Math.round(avgCommunication * 10) / 10,
        onTimeRate,
        totalRatings: allRatings.length,
        tripHistory: tripHistory.slice(0, 20) // Return last 20 trips
      });
    } catch (error) {
      console.error("Get carrier performance error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/carrier/documents/expiring - Get documents nearing expiry
  app.get("/api/carrier/documents/expiring", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      const windowDays = parseInt(req.query.windowDays as string) || 30;
      const now = new Date();
      const futureDate = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);

      // Get all documents for this carrier
      const allDocs = await storage.getDocumentsByUser(user.id);
      
      // Categorize by expiry status
      const expired: typeof allDocs = [];
      const expiringSoon: typeof allDocs = [];
      const healthy: typeof allDocs = [];

      for (const doc of allDocs) {
        if (!doc.expiryDate) {
          healthy.push(doc);
          continue;
        }
        const expiryDate = new Date(doc.expiryDate);
        if (expiryDate < now) {
          expired.push(doc);
        } else if (expiryDate <= futureDate) {
          expiringSoon.push(doc);
        } else {
          healthy.push(doc);
        }
      }

      res.json({
        expired,
        expiringSoon,
        healthy,
        summary: {
          totalDocs: allDocs.length,
          expiredCount: expired.length,
          expiringSoonCount: expiringSoon.length,
          healthyCount: healthy.length,
        }
      });
    } catch (error) {
      console.error("Get expiring documents error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/carrier/documents - Get all carrier documents (compliance docs)
  app.get("/api/carrier/documents", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      // Get all documents for this carrier that are NOT shipment documents
      const allDocs = await storage.getDocumentsByUser(user.id);
      
      // Filter to only include compliance documents (no load_id)
      const complianceDocs = allDocs.filter(doc => !doc.loadId);
      
      res.json(complianceDocs);
    } catch (error) {
      console.error("Get carrier documents error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/carrier/documents - Upload a new document
  app.post("/api/carrier/documents", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      const { documentType, fileName, fileUrl, fileSize, expiryDate, truckId, driverId } = req.body;

      // Validate required fields
      if (!documentType || !fileName || !fileUrl) {
        return res.status(400).json({ error: "Document type, file name, and file URL are required" });
      }

      // Validate document type
      const validDocTypes = ["license", "rc", "insurance", "fitness", "permit", "puc", "pan_card", "aadhar", "pod", "invoice", "other"];
      if (!validDocTypes.includes(documentType)) {
        return res.status(400).json({ error: "Invalid document type" });
      }

      // Validate file URL format (must be data URL or valid HTTP URL)
      if (!fileUrl.startsWith("data:") && !fileUrl.startsWith("http://") && !fileUrl.startsWith("https://")) {
        return res.status(400).json({ error: "Invalid file URL format. Must be a data URL or HTTP URL" });
      }

      // Validate file size (max 10MB for base64, accounting for ~33% overhead)
      const maxFileSize = 10 * 1024 * 1024; // 10MB
      if (fileSize && fileSize > maxFileSize) {
        return res.status(400).json({ error: "File size exceeds maximum allowed (10MB)" });
      }

      // Validate driverId belongs to the carrier
      if (driverId) {
        const driver = await storage.getDriver(driverId);
        if (!driver || driver.carrierId !== user.id) {
          return res.status(400).json({ error: "Invalid driver selected" });
        }
      }

      // Validate truckId belongs to the carrier
      if (truckId) {
        const truck = await storage.getTruck(truckId);
        if (!truck || truck.carrierId !== user.id) {
          return res.status(400).json({ error: "Invalid truck selected" });
        }
      }

      // Delete existing documents of the same type (replacement behavior)
      // This ensures uploading a new insurance doc replaces the old one
      const existingDocs = await storage.getDocumentsByUser(user.id);
      const docsToReplace = existingDocs.filter(d => d.documentType === documentType);
      for (const oldDoc of docsToReplace) {
        await storage.deleteDocument(oldDoc.id);
      }

      const newDoc = await storage.createDocument({
        userId: user.id,
        documentType,
        fileName,
        fileUrl,
        fileSize: fileSize || 0,
        expiryDate: expiryDate ? new Date(expiryDate) : null,
        truckId: truckId || null,
        driverId: driverId || null,
        isVerified: false,
      });

      // Broadcast to admins for real-time document verification updates
      broadcastMarketplaceEvent("carrier_document_uploaded", {
        carrierId: user.id,
        carrierName: user.companyName || user.username,
        documentId: newDoc.id,
        documentType,
        fileName,
        isVerified: false,
        uploadedAt: new Date().toISOString(),
      });

      // Auto-create or update verification record when carrier uploads documents
      // This ensures the carrier appears in admin's verification queue
      let verification = await storage.getCarrierVerificationByCarrier(user.id);
      const carrierProfile = await storage.getCarrierProfile(user.id);
      
      if (!verification) {
        // Create a new verification record for this carrier
        verification = await storage.createCarrierVerification({
          carrierId: user.id,
          carrierType: carrierProfile?.carrierType || "enterprise",
          fleetSize: carrierProfile?.fleetSize || 1,
          status: "pending",
          notes: null,
        });
      } else if (verification.status === "rejected") {
        // Reset to pending if carrier uploads new documents after rejection
        // Update submittedAt with current timestamp for resubmission
        await storage.updateCarrierVerification(verification.id, {
          status: "pending",
          rejectionReason: null,
          submittedAt: new Date(),
        });
        verification = await storage.getCarrierVerification(verification.id);
      }

      // Also create a verification document linked to the verification record
      if (verification) {
        // Check if verification document of same type exists
        const existingVerifDocs = await storage.getVerificationDocuments(verification.id);
        const existingVerifDoc = existingVerifDocs.find(d => d.documentType === documentType);
        
        if (existingVerifDoc) {
          // Update existing verification document
          await storage.updateVerificationDocument(existingVerifDoc.id, {
            fileName,
            fileUrl,
            status: "pending",
          });
        } else {
          // Create new verification document
          await storage.createVerificationDocument({
            verificationId: verification.id,
            carrierId: user.id,
            documentType,
            fileName,
            fileUrl,
            status: "pending",
          });
        }
      }

      res.json(newDoc);
    } catch (error) {
      console.error("Upload document error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/carrier/documents/:id - Get a specific document
  app.get("/api/carrier/documents/:id", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      const doc = await storage.getDocument(req.params.id);
      if (!doc || doc.userId !== user.id) {
        return res.status(404).json({ error: "Document not found" });
      }

      res.json(doc);
    } catch (error) {
      console.error("Get document error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /api/carrier/documents/:id - Update a document
  app.patch("/api/carrier/documents/:id", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      const doc = await storage.getDocument(req.params.id);
      if (!doc || doc.userId !== user.id) {
        return res.status(404).json({ error: "Document not found" });
      }

      const { fileName, fileUrl, fileSize, expiryDate } = req.body;
      const updates: any = {};
      if (fileName) updates.fileName = fileName;
      if (fileUrl) updates.fileUrl = fileUrl;
      if (fileSize !== undefined) updates.fileSize = fileSize;
      if (expiryDate !== undefined) updates.expiryDate = expiryDate ? new Date(expiryDate) : null;

      const updated = await storage.updateDocument(req.params.id, updates);
      res.json(updated);
    } catch (error) {
      console.error("Update document error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /api/carrier/documents/:id - Delete a document
  app.delete("/api/carrier/documents/:id", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      const doc = await storage.getDocument(req.params.id);
      if (!doc || doc.userId !== user.id) {
        return res.status(404).json({ error: "Document not found" });
      }

      await storage.deleteDocument(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Delete document error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/carrier/solo/truck - Get single truck for solo carrier
  app.get("/api/carrier/solo/truck", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      const carrierProfile = await storage.getCarrierProfile(user.id);
      if (carrierProfile?.carrierType !== "solo") {
        return res.status(403).json({ error: "Solo carrier access only" });
      }

      const trucks = await storage.getTrucksByCarrier(user.id);
      const truck = trucks[0]; // Solo carriers have one truck

      if (!truck) {
        return res.json({ truck: null, documents: [], documentAlerts: [] });
      }

      // Get truck documents
      const allDocs = await storage.getDocumentsByUser(user.id);
      const truckDocs = allDocs.filter(d => d.truckId === truck.id || 
        ["rc", "insurance", "fitness", "license"].includes(d.documentType));

      // Calculate document alerts
      const now = new Date();
      const thirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      const documentAlerts = truckDocs.filter(d => {
        if (!d.expiryDate) return false;
        const expiry = new Date(d.expiryDate);
        return expiry <= thirtyDays;
      }).map(d => ({
        documentId: d.id,
        documentType: d.documentType,
        fileName: d.fileName,
        expiryDate: d.expiryDate,
        daysUntilExpiry: d.expiryDate ? Math.ceil((new Date(d.expiryDate).getTime() - now.getTime()) / (24 * 60 * 60 * 1000)) : null,
        isExpired: d.expiryDate ? new Date(d.expiryDate) < now : false,
      }));

      res.json({ truck, documents: truckDocs, documentAlerts });
    } catch (error) {
      console.error("Get solo truck error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /api/carrier/truck/:truckId - Update truck info
  app.patch("/api/carrier/truck/:truckId", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      const { truckId } = req.params;
      const trucks = await storage.getTrucksByCarrier(user.id);
      const truck = trucks.find(t => t.id === truckId);

      if (!truck) {
        return res.status(404).json({ error: "Truck not found" });
      }

      const { licensePlate, truckType, capacity, capacityUnit, currentLocation, make, model, year, city, registrationDate } = req.body;

      // Update truck in database
      const updatedTruck = await db.update(trucksTable)
        .set({
          ...(licensePlate && { licensePlate }),
          ...(truckType && { truckType }),
          ...(capacity !== undefined && { capacity: parseInt(capacity) }),
          ...(capacityUnit && { capacityUnit }),
          ...(currentLocation !== undefined && { currentLocation }),
          ...(make !== undefined && { make }),
          ...(model !== undefined && { model }),
          ...(year !== undefined && { year: parseInt(year) }),
          ...(city !== undefined && { city }),
          ...(registrationDate !== undefined && { registrationDate: registrationDate ? new Date(registrationDate) : null }),
        })
        .where(eq(trucksTable.id, truckId))
        .returning();

      res.json(updatedTruck[0]);
    } catch (error) {
      console.error("Update truck error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/carrier/solo/profile - Get owner-operator profile
  app.get("/api/carrier/solo/profile", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      // Run all queries in parallel for better performance
      const [carrierProfile, trucks, allDocs, shipments] = await Promise.all([
        storage.getCarrierProfile(user.id),
        storage.getTrucksByCarrier(user.id),
        storage.getDocumentsByUser(user.id),
        storage.getShipmentsByCarrier(user.id),
      ]);
      
      const truck = trucks[0];
      const driverDocs = allDocs.filter(d => 
        ["license", "pan_card", "aadhar", "aadhaar"].includes(d.documentType)
      );
      const completedTrips = shipments.filter(s => s.status === "delivered").length;
      const totalTrips = shipments.length;

      res.json({
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          phone: user.phone,
          companyName: user.companyName,
          avatar: user.avatar,
        },
        carrierProfile,
        truck,
        driverDocuments: driverDocs,
        stats: {
          completedTrips,
          totalTrips,
          rating: carrierProfile?.rating || "4.5",
          reliabilityScore: carrierProfile?.reliabilityScore || "0",
        }
      });
    } catch (error) {
      console.error("Get solo profile error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /api/carrier/solo/profile - Update owner-operator profile
  app.patch("/api/carrier/solo/profile", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      const { phone, companyName, bio } = req.body;

      // Update user fields
      if (phone || companyName) {
        await storage.updateUser(user.id, { phone, companyName });
      }

      // Update carrier profile bio
      if (bio !== undefined) {
        const profile = await storage.getCarrierProfile(user.id);
        if (profile) {
          await storage.updateCarrierProfile(user.id, { bio });
        }
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Update solo profile error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/settlements - Create carrier settlement
  app.post("/api/admin/settlements", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { loadId, carrierId, invoiceId, grossAmount, platformFee, deductions, 
              deductionReason, netPayout, scheduledDate, notes } = req.body;

      if (!loadId || !carrierId || !grossAmount || !netPayout) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const settlement = await storage.createSettlement({
        loadId,
        carrierId,
        invoiceId,
        grossAmount,
        platformFee: platformFee || "0",
        deductions: deductions || "0",
        deductionReason,
        netPayout,
        scheduledDate: scheduledDate ? new Date(scheduledDate) : undefined,
        notes,
        status: "pending",
      });

      // Notify carrier
      const load = await storage.getLoad(loadId);
      await storage.createNotification({
        userId: carrierId,
        title: "Settlement Created",
        message: `A settlement of Rs. ${parseFloat(netPayout).toLocaleString('en-IN')} has been created for load ${load?.pickupCity} to ${load?.dropoffCity}.`,
        type: "payment",
        relatedLoadId: loadId,
      });

      res.status(201).json(settlement);
    } catch (error) {
      console.error("Create settlement error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/settlements/:id/pay - Mark settlement as paid
  app.post("/api/admin/settlements/:id/pay", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { paymentMethod, transactionId } = req.body;
      if (!paymentMethod) {
        return res.status(400).json({ error: "Payment method required" });
      }

      const updated = await storage.markSettlementPaid(req.params.id, {
        paymentMethod,
        transactionId,
      });

      if (updated) {
        await storage.createNotification({
          userId: updated.carrierId,
          title: "Payment Received",
          message: `Your payout of Rs. ${parseFloat(updated.netPayout).toLocaleString('en-IN')} has been processed.`,
          type: "payment",
          relatedLoadId: updated.loadId,
        });
      }

      res.json(updated);
    } catch (error) {
      console.error("Mark settlement paid error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =============================================
  // ADMIN TROUBLESHOOTING DASHBOARD ENDPOINTS
  // =============================================

  // GET /api/admin/troubleshoot/load/:id - Full load diagnostics
  app.get("/api/admin/troubleshoot/load/:id", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const load = await storage.getLoad(req.params.id);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      // Get related data
      const shipper = await storage.getUser(load.shipperId);
      const pricing = await storage.getAdminPricingByLoad(load.id);
      const invoice = await storage.getInvoiceByLoad(load.id);
      const bidsData = await storage.getBidsByLoad(load.id);
      const auditLogs = await storage.getAuditLogsByLoad(load.id);
      const apiLogs = await storage.getApiLogsByLoad(load.id, 50);
      const pendingActions = await storage.getPendingActionsByLoad(load.id);

      // Build diagnostics
      const diagnostics = {
        loadBasics: {
          id: load.id,
          status: load.status,
          pickupCity: load.pickupCity,
          dropoffCity: load.dropoffCity,
          distance: load.distance,
          weight: load.weight,
          requiredTruckType: load.requiredTruckType,
          finalPrice: load.finalPrice,
          adminFinalPrice: load.adminFinalPrice,
          hasFinalPrice: !!load.finalPrice || !!load.adminFinalPrice,
          createdAt: load.createdAt,
          submittedAt: load.submittedAt,
          postedAt: load.postedAt,
        },
        shipperInfo: shipper ? {
          id: shipper.id,
          username: shipper.username,
          companyName: shipper.companyName,
          isVerified: shipper.isVerified,
          kycVerified: load.kycVerified,
        } : null,
        pricingInfo: pricing ? {
          id: pricing.id,
          status: pricing.status,
          suggestedPrice: pricing.suggestedPrice,
          finalPrice: pricing.finalPrice,
          requiresApproval: pricing.requiresApproval,
          approvedAt: pricing.approvedAt,
          rejectedAt: pricing.rejectedAt,
          rejectionReason: pricing.rejectionReason,
        } : null,
        invoiceInfo: invoice ? {
          id: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          status: invoice.status,
          totalAmount: invoice.totalAmount,
          sentAt: invoice.sentAt,
          paidAt: invoice.paidAt,
        } : null,
        bidsCount: bidsData.length,
        auditLogCount: auditLogs.length,
        recentApiLogs: apiLogs.slice(0, 10),
        pendingActions: pendingActions,
        healthChecks: {
          hasPricing: !!pricing,
          hasInvoice: !!invoice,
          isPosted: ['posted', 'posted_open', 'posted_invite', 'assigned', 'bidding'].includes(load.status || ''),
          hasValidPrice: !!(load.finalPrice || load.adminFinalPrice),
          shipperVerified: !!shipper?.isVerified,
        },
      };

      // Log this view action
      await storage.createAuditLog({
        adminId: user.id,
        loadId: load.id,
        actionType: 'view_load',
        actionDescription: 'Admin viewed load diagnostics',
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      res.json(diagnostics);
    } catch (error) {
      console.error("Load diagnostics error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/troubleshoot/force-post/:loadId - Force post a load
  app.post("/api/admin/troubleshoot/force-post/:loadId", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { reason, finalPrice, postMode, tempPost } = req.body;
      if (!reason) {
        return res.status(400).json({ error: "Admin reason required for force post" });
      }

      const load = await storage.getLoad(req.params.loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      const beforeState = {
        status: load.status,
        finalPrice: load.finalPrice,
        adminFinalPrice: load.adminFinalPrice,
        postedAt: load.postedAt,
      };

      // Force update the load
      const price = finalPrice || load.adminFinalPrice || load.finalPrice || load.estimatedPrice || '0';
      const updated = await storage.updateLoad(load.id, {
        status: postMode === 'invite' ? 'posted_invite' : postMode === 'assign' ? 'assigned' : 'posted_open',
        adminFinalPrice: price,
        finalPrice: price,
        postedAt: new Date(),
        adminId: user.id,
        adminPostMode: postMode || 'open',
      });

      // Log the action
      await storage.createAuditLog({
        adminId: user.id,
        loadId: load.id,
        actionType: 'force_post',
        actionDescription: `Force posted load to ${postMode || 'open'} mode`,
        reason,
        beforeState,
        afterState: {
          status: updated?.status,
          finalPrice: updated?.finalPrice,
          adminFinalPrice: updated?.adminFinalPrice,
          postedAt: updated?.postedAt,
        },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        metadata: { tempPost: !!tempPost },
      });

      // Notify shipper
      await storage.createNotification({
        userId: load.shipperId,
        title: "Load Posted",
        message: `Your load from ${load.pickupCity} to ${load.dropoffCity} has been posted by admin.`,
        type: "load",
        relatedLoadId: load.id,
      });

      res.json({ success: true, load: updated });
    } catch (error) {
      console.error("Force post error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/troubleshoot/requeue/:loadId - Requeue a failed post action
  app.post("/api/admin/troubleshoot/requeue/:loadId", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { actionType, payload, priority } = req.body;
      const load = await storage.getLoad(req.params.loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      const queuedAction = await storage.createActionQueue({
        loadId: load.id,
        actionType: actionType || 'post',
        payload: payload || {},
        status: 'pending',
        priority: priority || 0,
        createdBy: user.id,
      });

      await storage.createAuditLog({
        adminId: user.id,
        loadId: load.id,
        actionType: 'requeue_post',
        actionDescription: `Requeued ${actionType || 'post'} action`,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        metadata: { queueId: queuedAction.id },
      });

      res.json({ success: true, queuedAction });
    } catch (error) {
      console.error("Requeue error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/troubleshoot/generate-invoice/:loadId - Generate standalone invoice (ONLY for awarded+ loads)
  app.post("/api/admin/troubleshoot/generate-invoice/:loadId", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { provisional, notes } = req.body;
      const load = await storage.getLoad(req.params.loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      // CRITICAL: Verify load is in awarded state or later before allowing invoice creation
      const allowedStatesForInvoice = ['awarded', 'invoice_created', 'invoice_sent', 'invoice_acknowledged', 'invoice_paid', 'in_transit', 'delivered', 'closed'];
      if (!load.status || !allowedStatesForInvoice.includes(load.status)) {
        return res.status(400).json({ 
          error: "Invoice can only be created after carrier finalization (awarded state or later)" 
        });
      }

      // Check for existing invoice
      const existingInvoice = await storage.getInvoiceByLoad(load.id);
      if (existingInvoice && !provisional) {
        return res.status(400).json({ error: "Invoice already exists. Use provisional flag to create provisional invoice." });
      }

      const finalPrice = parseFloat(load.adminFinalPrice || load.finalPrice || load.estimatedPrice || '0');
      const totalAmount = finalPrice; // No GST - direct price

      // Calculate advance payment from load
      const advancePercent = load.advancePaymentPercent || 0;
      const advanceAmount = advancePercent > 0 ? (totalAmount * (advancePercent / 100)).toFixed(2) : null;
      const balanceOnDelivery = advancePercent > 0 ? (totalAmount - parseFloat(advanceAmount || "0")).toFixed(2) : null;

      const invoiceNumber = await storage.generateInvoiceNumber();
      const invoice = await storage.createInvoice({
        invoiceNumber: provisional ? `PROV-${invoiceNumber}` : invoiceNumber,
        loadId: load.id,
        shipperId: load.shipperId,
        adminId: user.id,
        subtotal: String(finalPrice),
        taxPercent: '0',
        taxAmount: '0',
        totalAmount: String(Math.round(totalAmount)),
        advancePaymentPercent: advancePercent > 0 ? advancePercent : null,
        advancePaymentAmount: advanceAmount,
        balanceOnDelivery: balanceOnDelivery,
        status: 'draft',
        notes: provisional ? `Provisional invoice - ${notes || 'Generated pending platform confirmation'}` : notes,
        paymentTerms: 'Net 30',
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        lineItems: [
          { description: `Freight: ${load.pickupCity} to ${load.dropoffCity}`, amount: finalPrice }
        ],
      });

      await storage.createAuditLog({
        adminId: user.id,
        loadId: load.id,
        actionType: 'generate_invoice',
        actionDescription: provisional ? 'Generated provisional invoice' : 'Generated standalone invoice',
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        metadata: { invoiceId: invoice.id, provisional },
      });

      res.status(201).json(invoice);
    } catch (error) {
      console.error("Generate invoice error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/troubleshoot/send-invoice/:invoiceId - Send/resend invoice
  app.post("/api/admin/troubleshoot/send-invoice/:invoiceId", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { channel } = req.body; // email, sms, webhook
      const invoice = await storage.getInvoice(req.params.invoiceId);
      if (!invoice) {
        return res.status(404).json({ error: "Invoice not found" });
      }

      const updated = await storage.sendInvoice(invoice.id);

      // Notify shipper
      const load = await storage.getLoad(invoice.loadId);
      await storage.createNotification({
        userId: invoice.shipperId,
        title: "Invoice Sent",
        message: `Invoice ${invoice.invoiceNumber} for Rs. ${parseFloat(invoice.totalAmount).toLocaleString('en-IN')} has been sent for load ${load?.pickupCity} to ${load?.dropoffCity}.`,
        type: "payment",
        relatedLoadId: invoice.loadId,
      });

      await storage.createAuditLog({
        adminId: user.id,
        loadId: invoice.loadId,
        actionType: 'send_invoice',
        actionDescription: `Sent invoice via ${channel || 'email'}`,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        metadata: { invoiceId: invoice.id, channel: channel || 'email' },
      });

      res.json({ success: true, invoice: updated });
    } catch (error) {
      console.error("Send invoice error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/troubleshoot/rollback-price/:loadId - Rollback to previous price
  app.post("/api/admin/troubleshoot/rollback-price/:loadId", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { reason, targetPricingId } = req.body;
      if (!reason) {
        return res.status(400).json({ error: "Reason required for price rollback" });
      }

      const load = await storage.getLoad(req.params.loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      // Get pricing history
      const pricingHistory = await storage.getAdminPricingHistory(load.id);
      if (pricingHistory.length < 2 && !targetPricingId) {
        return res.status(400).json({ error: "No previous pricing to rollback to" });
      }

      const targetPricing = targetPricingId 
        ? pricingHistory.find(p => p.id === targetPricingId)
        : pricingHistory[1]; // Second most recent

      if (!targetPricing) {
        return res.status(404).json({ error: "Target pricing not found" });
      }

      const beforeState = {
        finalPrice: load.finalPrice,
        adminFinalPrice: load.adminFinalPrice,
      };

      await storage.updateLoad(load.id, {
        finalPrice: targetPricing.finalPrice,
        adminFinalPrice: targetPricing.finalPrice,
      });

      await storage.createAuditLog({
        adminId: user.id,
        loadId: load.id,
        actionType: 'rollback_price',
        actionDescription: `Rolled back price to ${targetPricing.finalPrice}`,
        reason,
        beforeState,
        afterState: { finalPrice: targetPricing.finalPrice, adminFinalPrice: targetPricing.finalPrice },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        metadata: { targetPricingId: targetPricing.id },
      });

      res.json({ success: true, rolledBackToPrice: targetPricing.finalPrice });
    } catch (error) {
      console.error("Rollback price error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/loads/:loadId/reprice-repost - Reprice and repost an already-posted load
  app.post("/api/admin/loads/:loadId/reprice-repost", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { 
        finalPrice, 
        postMode, 
        allowCounterBids, 
        invitedCarrierIds, 
        carrierAdvancePercent, 
        reason,
        platformMarginPercent: inputPlatformMargin,
        advancePaymentPercent: inputAdvancePercent,
        carrierPayout: inputCarrierPayout
      } = req.body;
      
      if (!finalPrice || isNaN(parseFloat(finalPrice))) {
        return res.status(400).json({ error: "Valid final price is required" });
      }

      const load = await storage.getLoad(req.params.loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      // Only allow repricing for loads in active marketplace states
      const allowedStatuses = ['posted_to_carriers', 'open_for_bid', 'counter_received', 'priced'];
      if (!allowedStatuses.includes(load.status || '')) {
        return res.status(400).json({ 
          error: `Cannot reprice load in ${load.status} status. Allowed statuses: ${allowedStatuses.join(', ')}` 
        });
      }

      // Store before state for audit
      const beforeState = {
        status: load.status,
        finalPrice: load.finalPrice,
        adminFinalPrice: load.adminFinalPrice,
        postedAt: load.postedAt,
        allowCounterBids: load.allowCounterBids,
      };

      // Calculate platform margin and carrier payout SERVER-SIDE (don't trust client)
      const priceNum = parseFloat(finalPrice);
      if (isNaN(priceNum) || priceNum <= 0) {
        return res.status(400).json({ error: "Price must be a positive number" });
      }
      
      // Validate and clamp margin/advance inputs
      const rawMargin = inputPlatformMargin !== undefined ? parseFloat(inputPlatformMargin) : 10;
      const platformMarginPercent = Math.max(0, Math.min(50, isNaN(rawMargin) ? 10 : rawMargin)); // Clamp 0-50%
      
      const rawAdvance = inputAdvancePercent !== undefined ? parseFloat(inputAdvancePercent) : 0;
      const advancePaymentPercent = Math.max(0, Math.min(100, isNaN(rawAdvance) ? 0 : rawAdvance)); // Clamp 0-100%
      
      // ALWAYS compute carrier payout server-side (ignore client carrierPayout to prevent tampering)
      const platformMargin = Math.round(priceNum * (platformMarginPercent / 100));
      const carrierPayout = Math.round(priceNum - platformMargin);

      // Determine target status:
      // - If load is in 'priced' status (never posted), keep it in 'priced' (just update price)
      // - If load was already posted to marketplace, reset to 'posted_to_carriers'
      const marketplaceStatuses = ['posted_to_carriers', 'open_for_bid', 'counter_received'];
      const isInMarketplace = marketplaceStatuses.includes(load.status || '');
      const targetStatus = isInMarketplace ? 'posted_to_carriers' : 'priced';

      // Reject any existing pending bids for this load (only relevant for marketplace loads)
      let rejectedBidsCount = 0;
      if (isInMarketplace) {
        const existingBids = await storage.getBidsByLoad(load.id);
        const pendingBids = existingBids.filter(b => b.status === 'pending' || b.status === 'countered');
        for (const bid of pendingBids) {
          await storage.updateBid(bid.id, { 
            status: 'rejected',
            // rejectedAt: new Date(), // Field removed from schema or not available
            notes: 'Load repriced and reposted by admin'
          });
        }
        rejectedBidsCount = pendingBids.length;
      }

      // Update load with new price
      // Note: adminFinalPrice = shipper's gross price (for invoicing)
      //       finalPrice = carrier payout (after platform margin)
      // IMPORTANT: Do NOT overwrite advancePaymentPercent - that is the shipper's preference for invoicing
      // The admin's carrier advance goes to carrierAdvancePercent only
      const updatePayload: any = {
        status: targetStatus,
        previousStatus: load.status,
        adminFinalPrice: priceNum.toString(),
        finalPrice: carrierPayout.toString(),
        // platformRatePercent: platformMarginPercent, // Removed as it doesn't exist on Load
        carrierAdvancePercent: advancePaymentPercent,
        adminId: user.id,
        allowCounterBids: allowCounterBids !== false,
        statusChangedBy: user.id,
        statusChangedAt: new Date(),
        // repricedAt: new Date(), // Removed as it doesn't exist on Load
        // repricedBy: user.id, // Removed as it doesn't exist on Load
        lastUpdatedBy: user.id,
        updatedAt: new Date(),
        priceBreakdown: {
            platformMarginPercent,
            platformMargin,
            carrierPayout,
            advancePaymentPercent,
            advanceAmount: Math.round(carrierPayout * (advancePaymentPercent / 100)),
            balanceAmount: Math.round(carrierPayout * ((100 - advancePaymentPercent) / 100)),
            originalPrice: load.adminFinalPrice || load.finalPrice,
            rejectedBidsCount,
        }
      };

      // Only set marketplace-specific fields if posting to carriers
      if (isInMarketplace) {
        updatePayload.adminPostMode = postMode || 'open';
        updatePayload.invitedCarrierIds = invitedCarrierIds || [];
        updatePayload.postedAt = new Date();
      }

      const updatedLoad = await storage.updateLoad(load.id, updatePayload);

      // Update existing invoice if one exists for this load
      try {
        const existingInvoices = await db.select().from(invoicesTable).where(eq(invoicesTable.loadId, load.id));
        if (existingInvoices.length > 0) {
          // Use the SHIPPER's original advance preference for invoice, NOT the carrier advance
          const shipperAdvancePercent = load.advancePaymentPercent || 0;
          const advanceAmt = Math.round(priceNum * (shipperAdvancePercent / 100));
          const balanceAmt = priceNum - advanceAmt;
          for (const inv of existingInvoices) {
            await db.update(invoicesTable).set({
              subtotal: priceNum.toString(),
              // Removed fields not in schema: totalAmount, platformMargin, estimatedCarrierPayout, adminPostedPrice, advancePaymentPercent, advancePaymentAmount, balanceOnDelivery
            }).where(eq(invoicesTable.id, inv.id));
          }
          console.log(`Updated ${existingInvoices.length} invoice(s) for repriced load ${load.id}`);
        }
      } catch (invoiceErr) {
        console.error("Error updating invoice after repricing:", invoiceErr);
      }

      // Create admin decision record for repricing
      const actionType = isInMarketplace ? 'reprice_repost' : 'reprice';
      await storage.createAdminDecision({
        loadId: load.id,
        adminId: user.id,
        suggestedPrice: load.adminFinalPrice || load.finalPrice || '0',
        finalPrice: priceNum.toString(),
        postingMode: postMode || 'open',
        invitedCarrierIds: invitedCarrierIds || [],
        comment: reason || (isInMarketplace ? 'Repriced and reposted' : 'Repriced'),
        pricingBreakdown: JSON.stringify({
          platformMarginPercent,
          platformMargin,
          carrierPayout,
          advancePaymentPercent,
          advanceAmount: Math.round(carrierPayout * (advancePaymentPercent / 100)),
          balanceAmount: Math.round(carrierPayout * ((100 - advancePaymentPercent) / 100)),
          originalPrice: load.adminFinalPrice || load.finalPrice,
          rejectedBidsCount,
        }),
        actionType,
      });

      // Create audit log
      await storage.createAuditLog({
        adminId: user.id,
        loadId: load.id,
        actionType,
        actionDescription: isInMarketplace 
          ? `Repriced load from ${load.adminFinalPrice || load.finalPrice} to ${priceNum} and reposted`
          : `Repriced load from ${load.adminFinalPrice || load.finalPrice} to ${priceNum}`,
        reason: reason || (isInMarketplace ? 'Admin repriced and reposted' : 'Admin repriced'),
        beforeState,
        afterState: {
          status: targetStatus,
          finalPrice: carrierPayout.toString(),
          adminFinalPrice: priceNum.toString(),
          postedAt: isInMarketplace ? new Date() : undefined,
          allowCounterBids: allowCounterBids !== false,
        },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        metadata: { 
          rejectedBidsCount,
          postMode: postMode || 'open',
          isInMarketplace,
        },
      });

      // Notify shipper about repricing
      const notificationMessage = isInMarketplace
        ? `Your load from ${load.pickupCity} to ${load.dropoffCity} has been repriced to Rs. ${priceNum.toLocaleString('en-IN')} and reposted to carriers.`
        : `Your load from ${load.pickupCity} to ${load.dropoffCity} has been repriced to Rs. ${priceNum.toLocaleString('en-IN')}.`;
      
      await storage.createNotification({
        userId: load.shipperId,
        title: "Load Repriced",
        message: notificationMessage,
        type: "load",
        relatedLoadId: load.id,
      });

      // Broadcast to carrier clients only if posting to marketplace
      if (isInMarketplace) {
        broadcastLoadPosted({
          id: load.id,
          pickupCity: load.pickupCity,
          dropoffCity: load.dropoffCity,
          adminFinalPrice: carrierPayout.toString(),
          requiredTruckType: load.requiredTruckType,
          status: 'posted_to_carriers',
        });
      }

      const responseMessage = isInMarketplace
        ? `Load repriced to Rs. ${priceNum.toLocaleString('en-IN')} and reposted to carriers`
        : `Load repriced to Rs. ${priceNum.toLocaleString('en-IN')}`;

      res.json({ 
        success: true, 
        load: updatedLoad,
        rejectedBidsCount,
        message: responseMessage
      });
    } catch (error) {
      console.error("Reprice and repost error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/troubleshoot/audit-trail/:loadId - Get audit trail for load
  app.get("/api/admin/troubleshoot/audit-trail/:loadId", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const auditLogs = await storage.getAuditLogsByLoad(req.params.loadId);
      res.json(auditLogs);
    } catch (error) {
      console.error("Get audit trail error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/troubleshoot/api-logs/:loadId - Get API logs for load
  app.get("/api/admin/troubleshoot/api-logs/:loadId", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const limit = parseInt(req.query.limit as string) || 50;
      const apiLogsData = await storage.getApiLogsByLoad(req.params.loadId, limit);
      res.json(apiLogsData);
    } catch (error) {
      console.error("Get API logs error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/feature-flags - Get all feature flags
  app.get("/api/admin/feature-flags", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const flags = await storage.getAllFeatureFlags();
      res.json(flags);
    } catch (error) {
      console.error("Get feature flags error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/feature-flags/:name/toggle - Toggle feature flag
  app.post("/api/admin/feature-flags/:name/toggle", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { isEnabled } = req.body;
      const updated = await storage.toggleFeatureFlag(req.params.name, isEnabled, user.id);

      if (!updated) {
        // Create if doesn't exist
        const newFlag = await storage.createFeatureFlag({
          name: req.params.name,
          isEnabled,
          updatedBy: user.id,
        });

        await storage.createAuditLog({
          adminId: user.id,
          actionType: 'toggle_feature_flag',
          actionDescription: `Created and set feature flag ${req.params.name} to ${isEnabled}`,
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
          metadata: { flagName: req.params.name, isEnabled },
        });

        return res.json(newFlag);
      }

      await storage.createAuditLog({
        adminId: user.id,
        actionType: 'toggle_feature_flag',
        actionDescription: `Toggled feature flag ${req.params.name} to ${isEnabled}`,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        metadata: { flagName: req.params.name, isEnabled },
      });

      res.json(updated);
    } catch (error) {
      console.error("Toggle feature flag error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/troubleshoot/queue - Get pending action queue
  app.get("/api/admin/troubleshoot/queue", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const pendingActions = await storage.getPendingActions();
      res.json(pendingActions);
    } catch (error) {
      console.error("Get action queue error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/troubleshoot/queue/:id/process - Process queued action
  app.post("/api/admin/troubleshoot/queue/:id/process", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const action = await storage.getActionQueue(req.params.id);
      if (!action) {
        return res.status(404).json({ error: "Action not found" });
      }

      const processed = await storage.processActionQueue(action.id);
      res.json({ success: true, action: processed });
    } catch (error) {
      console.error("Process queue action error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ==================== CARRIER VERIFICATION ROUTES ====================

  // GET /api/admin/verifications - Get all carrier verifications
  app.get("/api/admin/verifications", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const verifications = await storage.getAllCarrierVerifications();
      
      // Enrich with carrier info and documents
      const enrichedVerifications = await Promise.all(
        verifications.map(async (v) => {
          const carrier = await storage.getUser(v.carrierId);
          const profile = await storage.getCarrierProfile(v.carrierId);
          const documents = await storage.getVerificationDocuments(v.id);
          return {
            ...v,
            carrier: carrier ? { 
              id: carrier.id,
              username: carrier.username, 
              companyName: carrier.companyName, 
              email: carrier.email,
              phone: carrier.phone || profile?.companyPhone || null,
              // Use serviceZones if available, otherwise use city as fallback
              serviceZones: (profile?.serviceZones && profile.serviceZones.length > 0) 
                ? profile.serviceZones 
                : (profile?.city ? [profile.city] : []),
            } : null,
            profile,
            documents,
          };
        })
      );

      res.json(enrichedVerifications);
    } catch (error) {
      console.error("Get verifications error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/verifications/pending - Get pending verifications
  app.get("/api/admin/verifications/pending", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const verifications = await storage.getCarrierVerificationsByStatus("pending");
      
      const enrichedVerifications = await Promise.all(
        verifications.map(async (v) => {
          const carrier = await storage.getUser(v.carrierId);
          const profile = await storage.getCarrierProfile(v.carrierId);
          const documents = await storage.getVerificationDocuments(v.id);
          return {
            ...v,
            carrier: carrier ? { 
              id: carrier.id,
              username: carrier.username, 
              companyName: carrier.companyName, 
              email: carrier.email,
              phone: carrier.phone || profile?.companyPhone || null,
              // Use serviceZones if available, otherwise use city as fallback
              serviceZones: (profile?.serviceZones && profile.serviceZones.length > 0) 
                ? profile.serviceZones 
                : (profile?.city ? [profile.city] : []),
            } : null,
            profile,
            documents,
          };
        })
      );

      res.json(enrichedVerifications);
    } catch (error) {
      console.error("Get pending verifications error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/verifications/:id/approve - Approve carrier verification
  app.post("/api/admin/verifications/:id/approve", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const verification = await storage.getCarrierVerification(req.params.id);
      if (!verification) {
        return res.status(404).json({ error: "Verification not found" });
      }

      // Validate request body - only allow safe fields
      const approveSchema = z.object({
        notes: z.string().optional(),
      });

      const validatedBody = approveSchema.parse(req.body);

      // Update verification status with server-controlled sensitive fields
      const updated = await storage.updateCarrierVerification(req.params.id, {
        status: "approved", // Server-controlled
        reviewedBy: user.id, // Always use authenticated admin
        reviewedAt: new Date(), // Server timestamp
        notes: validatedBody.notes,
      });

      // Get carrier info for user update
      const carrierUser = await storage.getUser(verification.carrierId);
      
      // Update user with verified status and sync business info from verification
      if (verification.carrierType === "enterprise") {
        // Enterprise carriers: use business info from verification
        await storage.updateUser(verification.carrierId, { 
          isVerified: true,
          companyName: carrierUser?.companyName || undefined,
          companyAddress: verification.businessAddress || undefined,
        });
      } else {
        // Solo carriers: just set verified
        await storage.updateUser(verification.carrierId, { 
          isVerified: true,
        });
      }

      // Sync carrierType from verification to carrierProfiles on approval
      if (verification.carrierType) {
        const profile = await storage.getCarrierProfile(verification.carrierId);
        if (profile) {
          // Properly parse fleetSize - solo drivers always have 1, enterprise use existing or 0
          const newFleetSize = verification.carrierType === "solo" 
            ? 1 
            : (typeof verification.fleetSize === 'number' 
                ? verification.fleetSize 
                : (typeof profile.fleetSize === 'number' ? profile.fleetSize : 0));
          await storage.updateCarrierProfile(verification.carrierId, { 
            carrierType: verification.carrierType,
            fleetSize: newFleetSize
          });
        }
      }

      // Get verification documents and update their status to approved
      const verificationDocs = await storage.getVerificationDocuments(req.params.id);
      
      // Get existing carrier documents to avoid duplicates
      const existingDocs = await storage.getDocumentsByUser(verification.carrierId);
      const existingFileUrls = new Set(existingDocs.map(d => d.fileUrl));
      
      // Update each verification document to approved and copy to carrier's general documents
      for (const doc of verificationDocs) {
        // Update verification document status to approved
        await storage.updateVerificationDocument(doc.id, {
          status: "approved",
          reviewedBy: user.id,
          reviewedAt: new Date(),
        });
        
        // Only copy to carrier's general documents if not already exists (idempotency)
        if (!existingFileUrls.has(doc.fileUrl)) {
          await storage.createDocument({
            userId: verification.carrierId,
            documentType: doc.documentType,
            fileName: doc.fileName,
            fileUrl: doc.fileUrl,
            fileSize: doc.fileSize || undefined,
            expiryDate: doc.expiryDate || undefined,
            isVerified: true,
          });
        }
      }

      // Auto-create a truck with the vehicle info from verification (for both solo and enterprise carriers)
      // Only requires license plate - chassis number is optional for truck creation
      if (verification.licensePlateNumber) {
        try {
          // Check if a truck with this license plate already exists for this carrier
          const existingTrucks = await storage.getTrucksByCarrier(verification.carrierId);
          const truckExists = existingTrucks.some(t => t.licensePlate === verification.licensePlateNumber);
          
          if (!truckExists) {
            // Find document URLs from verification documents
            const rcDoc = verificationDocs.find(d => d.documentType === "rc");
            const insuranceDoc = verificationDocs.find(d => d.documentType === "insurance");
            const fitnessDoc = verificationDocs.find(d => d.documentType === "fitness");
            
            // Create the truck with all available info from verification
            // Note: truckType and capacity use defaults since they aren't captured in verification
            // Carrier can update these details in their fleet management
            const newTruck = await storage.createTruck({
              carrierId: verification.carrierId,
              truckType: "Open Body", // Default - carrier should update in My Truck/Fleet
              licensePlate: verification.licensePlateNumber,
              capacity: 10, // Default capacity in tons - carrier should update
              capacityUnit: "tons",
              chassisNumber: verification.chassisNumber || undefined,
              registrationNumber: verification.uniqueRegistrationNumber || undefined,
              permitType: verification.permitType || "national",
              rcDocumentUrl: rcDoc?.fileUrl || undefined,
              insuranceDocumentUrl: insuranceDoc?.fileUrl || undefined,
              fitnessDocumentUrl: fitnessDoc?.fileUrl || undefined,
              isAvailable: true,
            });
            
            console.log(`Auto-created truck ${newTruck.id} for ${verification.carrierType} carrier ${verification.carrierId}`);
            
            // Notify carrier to complete their truck profile
            const docsAdded = [rcDoc, insuranceDoc, fitnessDoc].filter(Boolean).length;
            await storage.createNotification({
              userId: verification.carrierId,
              title: "Truck Added to Your Fleet",
              message: `Your truck (${verification.licensePlateNumber}) has been added with ${docsAdded} documents. Please update the truck type and capacity in your fleet settings.`,
              type: "info",
            });
          }
        } catch (truckError) {
          // Log error but don't fail the approval - truck can be added manually later
          console.error(`Failed to auto-create truck for ${verification.carrierType} carrier:`, truckError);
        }
      }

      // Create audit log
      await storage.createAuditLog({
        adminId: user.id,
        userId: verification.carrierId,
        actionType: "approve_verification",
        actionDescription: `Approved carrier verification for ${verification.carrierId} with ${verificationDocs.length} documents`,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      });

      // Broadcast real-time verification status to carrier (use carrierUser from earlier)
      broadcastVerificationStatus(verification.carrierId, "approved", {
        companyName: carrierUser?.companyName || "Carrier",
      });

      res.json(updated);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Approve verification error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/verifications/:id/reject - Reject carrier verification
  app.post("/api/admin/verifications/:id/reject", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const verification = await storage.getCarrierVerification(req.params.id);
      if (!verification) {
        return res.status(404).json({ error: "Verification not found" });
      }

      // Validate request body - only allow safe fields
      const rejectSchema = z.object({
        reason: z.string().min(1, "Rejection reason is required"),
        notes: z.string().optional(),
      });

      const validatedBody = rejectSchema.parse(req.body);

      // Update verification with server-controlled sensitive fields
      const updated = await storage.updateCarrierVerification(req.params.id, {
        status: "rejected", // Server-controlled
        reviewedBy: user.id, // Always use authenticated admin
        reviewedAt: new Date(), // Server timestamp
        rejectionReason: validatedBody.reason,
        notes: validatedBody.notes,
      });

      // Create audit log
      await storage.createAuditLog({
        adminId: user.id,
        userId: verification.carrierId,
        actionType: "reject_verification",
        actionDescription: `Rejected carrier verification for ${verification.carrierId}: ${validatedBody.reason}`,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      });

      // Get carrier info for broadcast
      const carrier = await storage.getUser(verification.carrierId);
      
      // Broadcast real-time verification status to carrier
      broadcastVerificationStatus(verification.carrierId, "rejected", {
        companyName: carrier?.companyName || "Carrier",
        reason: validatedBody.reason,
      });

      res.json(updated);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Reject verification error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/verifications/:id/hold - Put carrier verification on hold
  app.post("/api/admin/verifications/:id/hold", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const verification = await storage.getCarrierVerification(req.params.id);
      if (!verification) {
        return res.status(404).json({ error: "Verification not found" });
      }

      // Validate request body - only allow safe fields
      const holdSchema = z.object({
        notes: z.string().min(1, "Notes are required when putting on hold"),
      });

      const validatedBody = holdSchema.parse(req.body);

      // Update verification with server-controlled sensitive fields
      const updated = await storage.updateCarrierVerification(req.params.id, {
        status: "on_hold", // Server-controlled
        reviewedBy: user.id, // Always use authenticated admin
        reviewedAt: new Date(), // Server timestamp
        notes: validatedBody.notes,
      });

      // Create audit log
      await storage.createAuditLog({
        adminId: user.id,
        userId: verification.carrierId,
        actionType: "hold_verification",
        actionDescription: `Put carrier verification on hold for ${verification.carrierId}: ${validatedBody.notes}`,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      });

      // Get carrier info for broadcast
      const carrier = await storage.getUser(verification.carrierId);
      
      // Broadcast real-time verification status to carrier
      broadcastVerificationStatus(verification.carrierId, "on_hold", {
        companyName: carrier?.companyName || "Carrier",
        reason: validatedBody.notes,
      });

      res.json(updated);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Put verification on hold error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /api/admin/verification-documents/:id - Approve or reject individual document
  app.patch("/api/admin/verification-documents/:id", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const documentId = req.params.id;
      
      // Validate request body
      const updateSchema = z.object({
        status: z.enum(["approved", "rejected"]),
        rejectionReason: z.string().optional(),
      });

      const validatedBody = updateSchema.parse(req.body);

      // Get the document to find the carrier
      const doc = await storage.getVerificationDocument(documentId);
      if (!doc) {
        return res.status(404).json({ error: "Document not found" });
      }

      // Update document status
      const updated = await storage.updateVerificationDocument(documentId, {
        status: validatedBody.status,
        rejectionReason: validatedBody.status === "rejected" ? validatedBody.rejectionReason : null,
        reviewedBy: user.id,
        reviewedAt: new Date(),
      });

      // If rejected, create notification for carrier
      if (validatedBody.status === "rejected") {
        const documentTypeLabel = DOCUMENT_TYPE_LABELS[doc.documentType] || doc.documentType.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
        
        await storage.createNotification({
          userId: doc.carrierId,
          title: "Document Rejected",
          message: `Your ${documentTypeLabel} has been rejected.${validatedBody.rejectionReason ? ` Reason: ${validatedBody.rejectionReason}` : ''} Please upload a valid document.`,
          type: "warning",
        });

        // Broadcast real-time notification
        broadcastMarketplaceEvent("document_rejected", {
          carrierId: doc.carrierId,
          documentType: doc.documentType,
          reason: validatedBody.rejectionReason,
        });
      }

      // Create audit log
      await storage.createAuditLog({
        adminId: user.id,
        userId: doc.carrierId,
        actionType: validatedBody.status === "approved" ? "approve_document" : "reject_document",
        actionDescription: `${validatedBody.status === "approved" ? "Approved" : "Rejected"} document ${doc.documentType} for carrier ${doc.carrierId}${validatedBody.rejectionReason ? `: ${validatedBody.rejectionReason}` : ""}`,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      });

      res.json(updated);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Update verification document error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =============================================
  // SHIPPER CREDIT ASSESSMENT ROUTES (Admin only)
  // =============================================

  // GET /api/admin/credit-assessments - Get all shippers with their credit profiles
  app.get("/api/admin/credit-assessments", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const shippersWithProfiles = await storage.getShippersWithCreditProfiles();
      res.json(shippersWithProfiles);
    } catch (error) {
      console.error("Get credit assessments error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/credit-assessments/:shipperId - Get specific shipper's credit profile
  app.get("/api/admin/credit-assessments/:shipperId", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const shipper = await storage.getUser(req.params.shipperId);
      if (!shipper || shipper.role !== "shipper") {
        return res.status(404).json({ error: "Shipper not found" });
      }

      const creditProfile = await storage.getShipperCreditProfile(req.params.shipperId);
      const evaluations = await storage.getShipperCreditEvaluations(req.params.shipperId);

      res.json({
        shipper,
        creditProfile,
        evaluations,
      });
    } catch (error) {
      console.error("Get shipper credit assessment error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/credit-assessments/:shipperId - Create or update shipper credit profile
  app.post("/api/admin/credit-assessments/:shipperId", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const shipper = await storage.getUser(req.params.shipperId);
      if (!shipper || shipper.role !== "shipper") {
        return res.status(404).json({ error: "Shipper not found" });
      }

      const ratingEnum = z.enum(["excellent", "good", "fair", "poor"]);
      const creditSchema = z.object({
        // Core fields
        creditLimit: z.string().optional(),
        creditScore: z.number().int().min(0).max(1000).optional(),
        riskLevel: z.enum(["low", "medium", "high", "critical"]).optional(),
        paymentTerms: z.number().int().min(0).max(365).optional(),
        notes: z.string().optional(),
        rationale: z.string().optional(),
        
        // Financial Health
        annualRevenue: z.string().optional(),
        totalAssets: z.string().optional(),
        debtSummary: z.string().optional(),
        cashFlowRating: ratingEnum.optional(),
        liquidityRatio: z.string().optional(),
        debtToEquityRatio: z.string().optional(),
        outstandingDebtAmount: z.string().optional(),
        
        // Business Profile
        businessYearsInOperation: z.number().int().min(0).optional(),
        companyScale: z.enum(["small", "medium", "large", "enterprise"]).optional(),
        paymentHistoryScore: z.number().int().min(0).max(100).optional(),
        averageDaysToPay: z.number().int().min(0).optional(),
        latePaymentCount: z.number().int().min(0).optional(),
        reputationRating: ratingEnum.optional(),
        
        // Compliance (India-specific)
        gstCompliant: z.boolean().optional(),
        gstNumber: z.string().optional(),
        incomeTaxCompliant: z.boolean().optional(),
        dgftRegistered: z.boolean().optional(),
        dgftIecNumber: z.string().optional(),
        hasValidContracts: z.boolean().optional(),
        contractTypes: z.string().optional(),
        confirmedOrdersValue: z.string().optional(),
        
        // Credit History
        creditBureauScore: z.number().int().min(0).max(900).optional(),
        creditUtilizationPercent: z.string().optional(),
        hasPublicRecords: z.boolean().optional(),
        publicRecordsDetails: z.string().optional(),
        
        // Notes
        financialAnalysisNotes: z.string().optional(),
        qualitativeAssessmentNotes: z.string().optional(),
      });

      const validated = creditSchema.parse(req.body);
      const existingProfile = await storage.getShipperCreditProfile(req.params.shipperId);

      // Build updates object with all fields
      const buildUpdates = () => {
        const updates: any = {
          lastAssessmentAt: new Date(),
          lastAssessedBy: user.id,
          isManualOverride: true, // Manual assessment locks from auto-updates
        };
        
        // Core fields
        if (validated.creditLimit !== undefined) updates.creditLimit = validated.creditLimit;
        if (validated.creditScore !== undefined) updates.creditScore = validated.creditScore;
        if (validated.riskLevel !== undefined) updates.riskLevel = validated.riskLevel;
        if (validated.paymentTerms !== undefined) updates.paymentTerms = validated.paymentTerms;
        if (validated.notes !== undefined) updates.notes = validated.notes;
        
        // Financial Health
        if (validated.annualRevenue !== undefined) updates.annualRevenue = validated.annualRevenue || null;
        if (validated.totalAssets !== undefined) updates.totalAssets = validated.totalAssets || null;
        if (validated.debtSummary !== undefined) updates.debtSummary = validated.debtSummary || null;
        if (validated.cashFlowRating !== undefined) updates.cashFlowRating = validated.cashFlowRating;
        if (validated.liquidityRatio !== undefined) updates.liquidityRatio = validated.liquidityRatio || null;
        if (validated.debtToEquityRatio !== undefined) updates.debtToEquityRatio = validated.debtToEquityRatio || null;
        if (validated.outstandingDebtAmount !== undefined) updates.outstandingDebtAmount = validated.outstandingDebtAmount || null;
        
        // Business Profile
        if (validated.businessYearsInOperation !== undefined) updates.businessYearsInOperation = validated.businessYearsInOperation;
        if (validated.companyScale !== undefined) updates.companyScale = validated.companyScale;
        if (validated.paymentHistoryScore !== undefined) updates.paymentHistoryScore = validated.paymentHistoryScore;
        if (validated.averageDaysToPay !== undefined) updates.averageDaysToPay = validated.averageDaysToPay;
        if (validated.latePaymentCount !== undefined) updates.latePaymentCount = validated.latePaymentCount;
        if (validated.reputationRating !== undefined) updates.reputationRating = validated.reputationRating;
        
        // Compliance
        if (validated.gstCompliant !== undefined) updates.gstCompliant = validated.gstCompliant;
        if (validated.gstNumber !== undefined) updates.gstNumber = validated.gstNumber || null;
        if (validated.incomeTaxCompliant !== undefined) updates.incomeTaxCompliant = validated.incomeTaxCompliant;
        if (validated.dgftRegistered !== undefined) updates.dgftRegistered = validated.dgftRegistered;
        if (validated.dgftIecNumber !== undefined) updates.dgftIecNumber = validated.dgftIecNumber || null;
        if (validated.hasValidContracts !== undefined) updates.hasValidContracts = validated.hasValidContracts;
        if (validated.contractTypes !== undefined) updates.contractTypes = validated.contractTypes || null;
        if (validated.confirmedOrdersValue !== undefined) updates.confirmedOrdersValue = validated.confirmedOrdersValue || null;
        
        // Credit History
        if (validated.creditBureauScore !== undefined) updates.creditBureauScore = validated.creditBureauScore;
        if (validated.creditUtilizationPercent !== undefined) updates.creditUtilizationPercent = validated.creditUtilizationPercent || null;
        if (validated.hasPublicRecords !== undefined) updates.hasPublicRecords = validated.hasPublicRecords;
        if (validated.publicRecordsDetails !== undefined) updates.publicRecordsDetails = validated.publicRecordsDetails || null;
        
        // Notes
        if (validated.financialAnalysisNotes !== undefined) updates.financialAnalysisNotes = validated.financialAnalysisNotes || null;
        if (validated.qualitativeAssessmentNotes !== undefined) updates.qualitativeAssessmentNotes = validated.qualitativeAssessmentNotes || null;
        
        return updates;
      };

      let profile;
      if (existingProfile) {
        // Update existing profile
        const updates = buildUpdates();

        // Calculate available credit
        const newLimit = validated.creditLimit ? parseFloat(validated.creditLimit) : parseFloat(String(existingProfile.creditLimit || "0"));
        const outstanding = parseFloat(String(existingProfile.outstandingBalance || "0"));
        updates.availableCredit = String(Math.max(0, newLimit - outstanding));

        profile = await storage.updateShipperCreditProfile(req.params.shipperId, updates);

        // Create evaluation record for audit trail
        await storage.createShipperCreditEvaluation({
          shipperId: req.params.shipperId,
          assessorId: user.id,
          evaluationType: "manual",
          previousCreditLimit: existingProfile.creditLimit,
          newCreditLimit: validated.creditLimit || existingProfile.creditLimit,
          previousRiskLevel: existingProfile.riskLevel,
          newRiskLevel: validated.riskLevel || existingProfile.riskLevel,
          previousCreditScore: existingProfile.creditScore,
          newCreditScore: validated.creditScore || existingProfile.creditScore,
          decision: "adjusted",
          rationale: validated.rationale || "Credit profile updated with comprehensive assessment",
        });
      } else {
        // Create new profile
        const updates = buildUpdates();
        const creditLimit = validated.creditLimit || "0";
        
        profile = await storage.createShipperCreditProfile({
          shipperId: req.params.shipperId,
          ...updates,
          creditLimit,
          creditScore: validated.creditScore || 500,
          riskLevel: validated.riskLevel || "medium",
          paymentTerms: validated.paymentTerms || 30,
          availableCredit: creditLimit,
        });

        // Create initial evaluation record
        await storage.createShipperCreditEvaluation({
          shipperId: req.params.shipperId,
          assessorId: user.id,
          evaluationType: "manual",
          newCreditLimit: creditLimit,
          newRiskLevel: validated.riskLevel || "medium",
          newCreditScore: validated.creditScore || 500,
          decision: "approved",
          rationale: validated.rationale || "Initial comprehensive credit assessment",
        });
      }

      // Create audit log
      await storage.createAuditLog({
        adminId: user.id,
        userId: req.params.shipperId,
        actionType: "credit_assessment",
        actionDescription: `${existingProfile ? "Updated" : "Created"} credit profile for shipper ${shipper.companyName || shipper.username}`,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      });

      res.json(profile);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Update credit assessment error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/credit-assessments/:shipperId/evaluations - Get evaluation history
  app.get("/api/admin/credit-assessments/:shipperId/evaluations", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const evaluations = await storage.getShipperCreditEvaluations(req.params.shipperId);
      res.json(evaluations);
    } catch (error) {
      console.error("Get evaluations error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/credit-assessments/:shipperId/auto-assess - Run auto-assessment for a shipper
  app.post("/api/admin/credit-assessments/:shipperId/auto-assess", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { runAutoAssessment } = await import("./services/credit-engine");
      const applyResults = req.body.apply === true;
      const result = await runAutoAssessment(req.params.shipperId, applyResults);

      if (applyResults && result.applied) {
        await storage.createAuditLog({
          adminId: user.id,
          userId: req.params.shipperId,
          actionType: "auto_credit_assessment",
          actionDescription: `Auto-assessment applied: Score ${result.creditScore}, Risk ${result.riskLevel}`,
          ipAddress: req.ip,
          userAgent: req.get("user-agent"),
        });
      }

      res.json(result);
    } catch (error) {
      console.error("Auto assessment error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/credit-assessments/bulk-auto-assess - Run auto-assessment for all shippers
  app.post("/api/admin/credit-assessments/bulk-auto-assess", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { runBulkAutoAssessment } = await import("./services/credit-engine");
      const applyResults = req.body.apply === true;
      const result = await runBulkAutoAssessment(applyResults);

      await storage.createAuditLog({
        adminId: user.id,
        actionType: "bulk_auto_credit_assessment",
        actionDescription: `Bulk auto-assessment: ${result.processed} processed, ${result.applied} applied, ${result.errors} errors`,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      });

      res.json(result);
    } catch (error) {
      console.error("Bulk auto assessment error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ========================================
  // SHIPPER ONBOARDING ROUTES
  // ========================================

  // POST /api/shipper/onboarding - Submit onboarding request
  app.post("/api/shipper/onboarding", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "shipper") {
        return res.status(403).json({ error: "Shipper access required" });
      }

      // Check for existing onboarding request
      const existing = await storage.getShipperOnboardingRequest(user.id);
      // Only block if already approved (verified) - security gate
      if (existing && existing.status === "approved") {
        return res.status(400).json({ 
          error: "Your business is already verified. Contact support if you need to update your information.",
          status: existing.status 
        });
      }

      const onboardingSchema = z.object({
        shipperRole: z.enum(["shipper", "transporter"]).optional().default("shipper"),
        legalCompanyName: z.string().min(1, "Company name is required"),
        tradeName: z.string().optional(),
        businessType: z.enum(["proprietorship", "partnership", "pvt_ltd", "public_ltd", "llp"]).optional(),
        incorporationDate: z.string().optional(),
        cinNumber: z.string().optional(),
        panNumber: z.string().min(10).max(10, "PAN must be 10 characters"),
        gstinNumber: z.string().optional(),
        registeredAddress: z.string().min(1, "Address is required"),
        registeredLocality: z.string().min(1, "Locality is required"),
        registeredCity: z.string().min(1, "City is required"),
        registeredCityCustom: z.string().optional(),
        registeredState: z.string().min(1, "State is required"),
        registeredCountry: z.string().min(1, "Country is required"),
        registeredPincode: z.string().min(6).max(6, "Pincode must be 6 digits"),
        operatingRegions: z.array(z.string()).optional(),
        primaryCommodities: z.array(z.string()).optional(),
        estimatedMonthlyLoads: z.union([z.number(), z.string().transform(v => v === '' ? undefined : parseInt(v, 10))]).optional(),
        avgLoadValueInr: z.string().optional(),
        contactPersonName: z.string().min(1, "Contact name is required"),
        contactPersonDesignation: z.string().optional(),
        contactPersonPhone: z.string().min(10, "Phone is required"),
        contactPersonEmail: z.string().email("Valid email required"),
        gstCertificateUrl: z.string().optional(),
        panCardUrl: z.string().optional(),
        incorporationCertificateUrl: z.string().optional(),
        cancelledChequeUrl: z.string().optional(),
        businessAddressProofUrl: z.string().optional(),
        selfieUrl: z.string().optional(),
        lrCopyUrl: z.string().optional(),
        aadhaarNumber: z.string().optional(),
        aadhaarCardUrl: z.string().optional(),
        tradeReference1Company: z.string().optional(),
        tradeReference1Contact: z.string().optional(),
        tradeReference1Phone: z.string().optional(),
        tradeReference2Company: z.string().optional(),
        tradeReference2Contact: z.string().optional(),
        tradeReference2Phone: z.string().optional(),
        bankName: z.string().optional(),
        bankAccountNumber: z.string().optional(),
        bankIfscCode: z.string().optional(),
        bankBranchName: z.string().optional(),
        preferredPaymentTerms: z.enum(["cod", "net_7", "net_15", "net_30", "net_45"]).optional(),
        requestedCreditLimit: z.string().optional(),
        referralSource: z.string().optional(),
        referralSalesPersonName: z.string().optional(),
        noGstCertificate: z.boolean().optional(),
        alternativeDocumentType: z.string().optional(),
        alternativeAuthorizationUrl: z.string().optional(),
      }).refine((data) => {
        if (data.shipperRole === "transporter" && !data.lrCopyUrl) {
          return false;
        }
        return true;
      }, {
        message: "LR Copy is required for Transporters",
        path: ["lrCopyUrl"]
      }).refine((data) => {
        if (data.businessType === "proprietorship" && !data.aadhaarNumber) {
          return false;
        }
        return true;
      }, {
        message: "Aadhaar number is required for Proprietorship",
        path: ["aadhaarNumber"]
      }).refine((data) => {
        if (data.businessType === "proprietorship" && !data.aadhaarCardUrl) {
          return false;
        }
        return true;
      }, {
        message: "Aadhaar card upload is required for Proprietorship",
        path: ["aadhaarCardUrl"]
      });

      const validatedData = onboardingSchema.parse(req.body);

      // Sanitize numeric fields - remove commas from formatted numbers
      const sanitizedCreditLimit = validatedData.requestedCreditLimit 
        ? validatedData.requestedCreditLimit.replace(/,/g, '') 
        : undefined;
      const sanitizedAvgLoadValue = validatedData.avgLoadValueInr
        ? validatedData.avgLoadValueInr.replace(/,/g, '')
        : undefined;

      let onboardingRequest;
      
      // If there's an existing request (any non-approved status), update it
      if (existing) {
        onboardingRequest = await storage.updateShipperOnboardingRequest(existing.id, {
          status: "pending",
          submittedAt: new Date(), // Update timestamp on resubmission
          ...validatedData,
          requestedCreditLimit: sanitizedCreditLimit,
          avgLoadValueInr: sanitizedAvgLoadValue,
          incorporationDate: validatedData.incorporationDate ? new Date(validatedData.incorporationDate) : undefined,
        });
      } else {
        // Create new request only if no existing record
        onboardingRequest = await storage.createShipperOnboardingRequest({
          shipperId: user.id,
          status: "pending",
          ...validatedData,
          requestedCreditLimit: sanitizedCreditLimit,
          avgLoadValueInr: sanitizedAvgLoadValue,
          incorporationDate: validatedData.incorporationDate ? new Date(validatedData.incorporationDate) : undefined,
        });
      }

      res.json(onboardingRequest);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Submit onboarding error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/shipper/onboarding - Get shipper's own onboarding status
  app.get("/api/shipper/onboarding", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "shipper") {
        return res.status(403).json({ error: "Shipper access required" });
      }

      const onboarding = await storage.getShipperOnboardingRequest(user.id);
      res.json(onboarding || null);
    } catch (error) {
      console.error("Get shipper onboarding error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/shipper/profile - Get shipper's business profile (for consistent data across platform)
  app.get("/api/shipper/profile", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "shipper") {
        return res.status(403).json({ error: "Shipper access required" });
      }

      const onboarding = await storage.getShipperOnboardingRequest(user.id);
      
      if (!onboarding || onboarding.status !== "approved") {
        return res.status(404).json({ error: "No approved profile found" });
      }

      // Return structured profile data from onboarding
      const profile = {
        id: user.id,
        userId: user.id,
        username: user.username,
        email: user.email,
        isVerified: user.isVerified,
        business: {
          legalCompanyName: onboarding.legalCompanyName,
          tradeName: onboarding.tradeName,
          businessType: onboarding.businessType,
          incorporationDate: onboarding.incorporationDate,
          cinNumber: onboarding.cinNumber,
          panNumber: onboarding.panNumber,
          gstinNumber: onboarding.gstinNumber,
        },
        address: {
          addressLine: onboarding.registeredAddress,
          city: onboarding.registeredCity === "other" ? onboarding.registeredCityCustom : onboarding.registeredCity,
          cityCustom: onboarding.registeredCityCustom,
          state: onboarding.registeredState,
          country: onboarding.registeredCountry || "India",
          pincode: onboarding.registeredPincode,
        },
        contact: {
          name: onboarding.contactPersonName,
          designation: onboarding.contactPersonDesignation,
          phone: onboarding.contactPersonPhone,
          email: onboarding.contactPersonEmail,
        },
        banking: {
          bankName: onboarding.bankName,
          accountNumber: onboarding.bankAccountNumber,
          ifscCode: onboarding.bankIfscCode,
          branchName: onboarding.bankBranchName,
        },
        operations: {
          operatingRegions: onboarding.operatingRegions,
          primaryCommodities: onboarding.primaryCommodities,
          estimatedMonthlyLoads: onboarding.estimatedMonthlyLoads,
          avgLoadValueInr: onboarding.avgLoadValueInr,
        },
        onboardingStatus: onboarding.status,
        approvedAt: onboarding.reviewedAt,
      };

      res.json(profile);
    } catch (error) {
      console.error("Get shipper profile error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/shipper/:id/profile - Get any shipper's profile (for admin/carrier use)
  app.get("/api/shipper/:id/profile", requireAuth, async (req, res) => {
    try {
      const shipperId = req.params.id;
      const shipper = await storage.getUser(shipperId);
      
      if (!shipper || shipper.role !== "shipper") {
        return res.status(404).json({ error: "Shipper not found" });
      }

      const onboarding = await storage.getShipperOnboardingRequest(shipperId);
      
      if (!onboarding || onboarding.status !== "approved") {
        // Return basic user info if not approved
        return res.json({
          id: shipper.id,
          username: shipper.username,
          email: shipper.email,
          isVerified: shipper.isVerified,
          companyName: shipper.companyName,
          business: null,
          address: null,
          contact: null,
        });
      }

      // Return structured profile data from onboarding
      const profile = {
        id: shipper.id,
        userId: shipper.id,
        username: shipper.username,
        email: shipper.email,
        isVerified: shipper.isVerified,
        business: {
          legalCompanyName: onboarding.legalCompanyName,
          tradeName: onboarding.tradeName,
          businessType: onboarding.businessType,
          incorporationDate: onboarding.incorporationDate,
          cinNumber: onboarding.cinNumber,
          panNumber: onboarding.panNumber,
          gstinNumber: onboarding.gstinNumber,
        },
        address: {
          addressLine: onboarding.registeredAddress,
          city: onboarding.registeredCity === "other" ? onboarding.registeredCityCustom : onboarding.registeredCity,
          cityCustom: onboarding.registeredCityCustom,
          state: onboarding.registeredState,
          country: onboarding.registeredCountry || "India",
          pincode: onboarding.registeredPincode,
        },
        contact: {
          name: onboarding.contactPersonName,
          designation: onboarding.contactPersonDesignation,
          phone: onboarding.contactPersonPhone,
          email: onboarding.contactPersonEmail,
        },
        onboardingStatus: onboarding.status,
      };

      res.json(profile);
    } catch (error) {
      console.error("Get shipper profile by id error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /api/shipper/onboarding/draft - Save draft data (auto-save)
  app.patch("/api/shipper/onboarding/draft", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "shipper") {
        return res.status(403).json({ error: "Shipper access required" });
      }

      const existing = await storage.getShipperOnboardingRequest(user.id);
      if (!existing) {
        return res.status(404).json({ error: "No onboarding request found" });
      }

      if (existing.status !== "draft") {
        return res.status(400).json({ 
          error: "Can only save drafts for requests in draft status",
          status: existing.status 
        });
      }

      const draftSchema = z.object({
        shipperRole: z.enum(["shipper", "transporter"]).optional(),
        legalCompanyName: z.string().optional(),
        tradeName: z.string().optional(),
        businessType: z.string().optional(),
        panNumber: z.string().optional(),
        gstinNumber: z.string().optional(),
        cinNumber: z.string().optional(),
        incorporationDate: z.string().optional(),
        registeredAddress: z.string().optional(),
        registeredLocality: z.string().optional(),
        registeredCity: z.string().optional(),
        registeredCityCustom: z.string().optional(),
        registeredState: z.string().optional(),
        registeredCountry: z.string().optional(),
        registeredPincode: z.string().optional(),
        operatingRegions: z.array(z.string()).optional(),
        primaryCommodities: z.array(z.string()).optional(),
        estimatedMonthlyLoads: z.union([z.number(), z.string().transform(v => v === '' ? undefined : parseInt(v, 10))]).optional(),
        avgLoadValueInr: z.string().optional(),
        contactPersonName: z.string().optional(),
        contactPersonDesignation: z.string().optional(),
        contactPersonPhone: z.string().optional(),
        contactPersonEmail: z.string().optional(),
        gstCertificateUrl: z.string().optional(),
        panCardUrl: z.string().optional(),
        incorporationCertificateUrl: z.string().optional(),
        cancelledChequeUrl: z.string().optional(),
        businessAddressProofUrl: z.string().optional(),
        selfieUrl: z.string().optional(),
        lrCopyUrl: z.string().optional(),
        aadhaarNumber: z.string().optional(),
        aadhaarCardUrl: z.string().optional(),
        tradeReference1Company: z.string().optional(),
        tradeReference1Contact: z.string().optional(),
        tradeReference1Phone: z.string().optional(),
        tradeReference2Company: z.string().optional(),
        tradeReference2Contact: z.string().optional(),
        tradeReference2Phone: z.string().optional(),
        bankName: z.string().optional(),
        bankAccountNumber: z.string().optional(),
        bankIfscCode: z.string().optional(),
        bankBranchName: z.string().optional(),
        preferredPaymentTerms: z.string().optional(),
        requestedCreditLimit: z.string().optional(),
        referralSource: z.string().optional(),
        referralSalesPersonName: z.string().optional(),
        noGstCertificate: z.boolean().optional(),
        alternativeDocumentType: z.string().optional(),
        alternativeAuthorizationUrl: z.string().optional(),
      });

      const validatedData = draftSchema.parse(req.body);

      // Sanitize numeric fields - remove commas from formatted numbers
      const sanitizedCreditLimit = validatedData.requestedCreditLimit 
        ? validatedData.requestedCreditLimit.replace(/,/g, '') 
        : undefined;
      const sanitizedAvgLoadValue = validatedData.avgLoadValueInr
        ? validatedData.avgLoadValueInr.replace(/,/g, '')
        : undefined;

      const updated = await storage.updateShipperOnboardingRequest(existing.id, {
        ...validatedData,
        requestedCreditLimit: sanitizedCreditLimit,
        avgLoadValueInr: sanitizedAvgLoadValue,
        incorporationDate: validatedData.incorporationDate ? new Date(validatedData.incorporationDate) : undefined,
      });

      res.json(updated);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Save draft error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PUT /api/shipper/onboarding - Update onboarding request (only if on_hold or rejected)
  app.put("/api/shipper/onboarding", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "shipper") {
        return res.status(403).json({ error: "Shipper access required" });
      }

      const existing = await storage.getShipperOnboardingRequest(user.id);
      if (!existing) {
        return res.status(404).json({ error: "No onboarding request found" });
      }

      if (existing.status !== "on_hold" && existing.status !== "rejected") {
        return res.status(400).json({ 
          error: "Can only update requests that are on hold or rejected",
          status: existing.status 
        });
      }

      const updateSchema = z.object({
        legalCompanyName: z.string().optional(),
        tradeName: z.string().optional(),
        businessType: z.string().optional(),
        panNumber: z.string().optional(),
        gstinNumber: z.string().optional(),
        registeredAddress: z.string().optional(),
        registeredLocality: z.string().optional(),
        registeredCity: z.string().optional(),
        registeredState: z.string().optional(),
        registeredPincode: z.string().optional(),
        contactPersonName: z.string().optional(),
        contactPersonPhone: z.string().optional(),
        contactPersonEmail: z.string().optional(),
        gstCertificateUrl: z.string().optional(),
        panCardUrl: z.string().optional(),
        incorporationCertificateUrl: z.string().optional(),
        cancelledChequeUrl: z.string().optional(),
        businessAddressProofUrl: z.string().optional(),
        selfieUrl: z.string().optional(),
        tradeReference1Company: z.string().optional(),
        tradeReference1Contact: z.string().optional(),
        tradeReference1Phone: z.string().optional(),
        tradeReference2Company: z.string().optional(),
        tradeReference2Contact: z.string().optional(),
        tradeReference2Phone: z.string().optional(),
        referralSource: z.string().optional(),
        referralSalesPersonName: z.string().optional(),
        noGstCertificate: z.boolean().optional(),
        alternativeDocumentType: z.string().optional(),
        alternativeAuthorizationUrl: z.string().optional(),
      });

      const validatedData = updateSchema.parse(req.body);

      const updated = await storage.updateShipperOnboardingRequest(existing.id, {
        ...validatedData,
        status: "pending", // Re-submit for review
        submittedAt: new Date(), // Update timestamp on resubmission
      });

      res.json(updated);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Update onboarding error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/onboarding-requests - Get all onboarding requests (admin)
  app.get("/api/admin/onboarding-requests", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { status } = req.query;
      let requests;
      if (status && typeof status === "string") {
        requests = await storage.getShipperOnboardingRequestsByStatus(status);
      } else {
        requests = await storage.getAllShipperOnboardingRequests();
      }

      // Enrich with shipper details - format as { request, user, creditProfile }
      const enrichedRequests = await Promise.all(
        requests.map(async (request) => {
          const shipper = await storage.getUser(request.shipperId);
          const creditProfile = await storage.getShipperCreditProfile(request.shipperId);
          return { request, user: shipper, creditProfile };
        })
      );

      res.json(enrichedRequests);
    } catch (error) {
      console.error("Get onboarding requests error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/onboarding-requests/:id - Get specific onboarding request (admin)
  app.get("/api/admin/onboarding-requests/:id", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const request = await storage.getShipperOnboardingRequestById(req.params.id);
      if (!request) {
        return res.status(404).json({ error: "Onboarding request not found" });
      }

      const shipper = await storage.getUser(request.shipperId);
      const creditProfile = await storage.getShipperCreditProfile(request.shipperId);

      res.json({ request, user: shipper, creditProfile });
    } catch (error) {
      console.error("Get onboarding request error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/onboarding-requests/:id/review - Admin review decision
  app.post("/api/admin/onboarding-requests/:id/review", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const request = await storage.getShipperOnboardingRequestById(req.params.id);
      if (!request) {
        return res.status(404).json({ error: "Onboarding request not found" });
      }

      const reviewSchema = z.object({
        decision: z.enum(["approved", "rejected", "on_hold", "under_review"]),
        decisionNote: z.string().optional(),
        followUpDate: z.string().optional(),
      });

      const reviewData = reviewSchema.parse(req.body);

      // Update onboarding request
      const updatedRequest = await storage.updateShipperOnboardingRequest(request.id, {
        status: reviewData.decision,
        reviewedBy: user.id,
        reviewedAt: new Date(),
        decisionNote: reviewData.decisionNote,
        followUpDate: reviewData.followUpDate ? new Date(reviewData.followUpDate) : undefined,
      });

      // If approved, update user verification status and sync business info
      if (reviewData.decision === "approved") {
        // Build address from onboarding data
        const addressParts = [
          request.registeredAddress,
          request.registeredCity || request.registeredCityCustom,
          request.registeredState,
          request.registeredPincode,
        ].filter(Boolean);
        const fullAddress = addressParts.length > 0 ? addressParts.join(', ') : undefined;
        
        // Update user with verified status and business info from onboarding
        await storage.updateUser(request.shipperId, { 
          isVerified: true,
          companyName: request.legalCompanyName || request.tradeName || undefined,
          companyAddress: fullAddress,
          phone: request.contactPersonPhone || undefined,
        });
      }

      // Audit log
      await storage.createAuditLog({
        adminId: user.id,
        actionType: "shipper_onboarding_review",
        actionDescription: `${reviewData.decision} onboarding for shipper ${request.shipperId}`,
        metadata: {
          entityType: "shipper_onboarding",
          entityId: request.id,
          previousState: JSON.stringify({ status: request.status }),
          newState: JSON.stringify({ status: reviewData.decision }),
        },
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      });

      res.json(updatedRequest);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Review onboarding error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/admin/onboarding-requests/stats - Get onboarding statistics
  app.get("/api/admin/onboarding-requests/stats", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const allRequests = await storage.getAllShipperOnboardingRequests();
      const stats = {
        total: allRequests.length,
        pending: allRequests.filter(r => r.status === "pending").length,
        underReview: allRequests.filter(r => r.status === "under_review").length,
        approved: allRequests.filter(r => r.status === "approved").length,
        rejected: allRequests.filter(r => r.status === "rejected").length,
        onHold: allRequests.filter(r => r.status === "on_hold").length,
      };

      res.json(stats);
    } catch (error) {
      console.error("Get onboarding stats error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/carrier/verification - Submit carrier verification request
  app.post("/api/carrier/verification", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      // Check for existing verification - if draft/on_hold/rejected, update it instead
      const existing = await storage.getCarrierVerificationByCarrier(user.id);
      if (existing && existing.status === "pending") {
        return res.status(400).json({ error: "You already have a pending verification request" });
      }

      // Extended schema for solo/fleet carrier onboarding
      const userInputSchema = z.object({
        carrierType: z.enum(["solo", "enterprise"]).optional().default("solo"),
        fleetSize: z.number().int().min(1).optional().default(1),
        notes: z.string().optional(),
        // Solo operator fields
        aadhaarNumber: z.string().optional(),
        driverLicenseNumber: z.string().optional(),
        permitType: z.enum(["national", "domestic"]).optional(),
        uniqueRegistrationNumber: z.string().optional(),
        chassisNumber: z.string().optional(),
        licensePlateNumber: z.string().optional(),
        // Fleet/Company fields (also used by solo operators for address)
        incorporationType: z.enum(["pvt_ltd", "llp", "proprietorship", "partnership"]).optional(),
        businessType: z.enum(["sole_proprietor", "registered_partnership", "non_registered_partnership", "other"]).optional(),
        cinNumber: z.string().optional(),
        partnerName: z.string().optional(),
        businessRegistrationNumber: z.string().optional(),
        businessAddress: z.string().optional(),
        businessLocality: z.string().optional(),
        panNumber: z.string().optional(),
        gstinNumber: z.string().optional(),
        tanNumber: z.string().optional(),
      });

      const userInput = userInputSchema.parse(req.body);

      // Build final payload with ONLY server-controlled sensitive fields
      const verification = await storage.createCarrierVerification({
        carrierId: user.id,
        carrierType: userInput.carrierType,
        fleetSize: userInput.fleetSize,
        status: "pending",
        notes: userInput.notes,
        aadhaarNumber: userInput.aadhaarNumber,
        driverLicenseNumber: userInput.driverLicenseNumber,
        permitType: userInput.permitType,
        uniqueRegistrationNumber: userInput.uniqueRegistrationNumber,
        chassisNumber: userInput.chassisNumber,
        licensePlateNumber: userInput.licensePlateNumber,
        incorporationType: userInput.incorporationType,
        businessRegistrationNumber: userInput.businessRegistrationNumber,
        businessAddress: userInput.businessAddress,
        businessLocality: userInput.businessLocality,
        panNumber: userInput.panNumber,
        gstinNumber: userInput.gstinNumber,
        tanNumber: userInput.tanNumber,
        submittedAt: new Date(),
      });

      res.json(verification);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Submit verification error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/carrier/onboarding - Get or create carrier onboarding request
  app.get("/api/carrier/onboarding", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      let onboarding = await storage.getCarrierVerificationByCarrier(user.id);
      
      // Auto-create draft if no onboarding request exists
      if (!onboarding) {
        // Get carrier profile to determine carrier type
        const profile = await storage.getCarrierProfile(user.id);
        onboarding = await storage.createCarrierVerification({
          carrierId: user.id,
          carrierType: profile?.carrierType || "solo",
          fleetSize: profile?.fleetSize || 1,
          status: "draft",
        });
      }

      const documents = await storage.getVerificationDocuments(onboarding.id);
      res.json({ ...onboarding, documents });
    } catch (error) {
      console.error("Get carrier onboarding error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /api/carrier/onboarding/draft - Auto-save draft carrier onboarding
  app.patch("/api/carrier/onboarding/draft", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      const onboarding = await storage.getCarrierVerificationByCarrier(user.id);
      if (!onboarding) {
        return res.status(404).json({ error: "No onboarding request found" });
      }

      // Allow updates for draft, on_hold, rejected, pending, or under_review status (carriers can edit while pending review)
      if (!["draft", "on_hold", "rejected", "pending", "under_review"].includes(onboarding.status || "")) {
        return res.status(400).json({ error: "Cannot update onboarding request in current status" });
      }

      const updateSchema = z.object({
        carrierType: z.enum(["solo", "enterprise"]).optional(),
        fleetSize: z.number().int().min(1).optional(),
        notes: z.string().optional(),
        // Solo operator fields
        aadhaarNumber: z.string().optional(),
        driverLicenseNumber: z.string().optional(),
        permitType: z.enum(["national", "domestic"]).optional(),
        uniqueRegistrationNumber: z.string().optional(),
        chassisNumber: z.string().optional(),
        licensePlateNumber: z.string().optional(),
        // Fleet/Company fields (also used by solo operators for address)
        incorporationType: z.enum(["pvt_ltd", "llp", "proprietorship", "partnership"]).optional(),
        businessType: z.enum(["sole_proprietor", "registered_partnership", "non_registered_partnership", "other"]).optional(),
        cinNumber: z.string().optional(),
        partnerName: z.string().optional(),
        businessRegistrationNumber: z.string().optional(),
        businessAddress: z.string().optional(),
        businessLocality: z.string().optional(),
        panNumber: z.string().optional(),
        gstinNumber: z.string().optional(),
        noGstinNumber: z.boolean().optional(),
        tanNumber: z.string().optional(),
        // Bank details (both solo and fleet)
        bankName: z.string().optional(),
        bankAccountNumber: z.string().optional(),
        bankIfscCode: z.string().optional(),
        bankAccountHolderName: z.string().optional(),
      });

      const updates = updateSchema.parse(req.body);
      const updated = await storage.updateCarrierVerification(onboarding.id, updates);
      
      // Sync carrierType to carrierProfiles table if provided
      if (updates.carrierType) {
        const profile = await storage.getCarrierProfile(user.id);
        if (profile) {
          // Properly parse fleetSize - solo drivers always have 1, enterprise use existing or 0
          const newFleetSize = updates.carrierType === "solo" 
            ? 1 
            : (typeof updates.fleetSize === 'number' 
                ? updates.fleetSize 
                : (typeof profile.fleetSize === 'number' ? profile.fleetSize : 0));
          await storage.updateCarrierProfile(user.id, { 
            carrierType: updates.carrierType,
            fleetSize: newFleetSize
          });
        }
      }
      
      const documents = await storage.getVerificationDocuments(onboarding.id);
      res.json({ ...updated, documents });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Update carrier onboarding draft error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/carrier/onboarding/submit - Submit carrier onboarding for review
  app.post("/api/carrier/onboarding/submit", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      const onboarding = await storage.getCarrierVerificationByCarrier(user.id);
      if (!onboarding) {
        return res.status(404).json({ error: "No onboarding request found" });
      }

      // Allow submission from draft, on_hold, rejected, pending, or under_review status (carriers can edit while pending review)
      if (!["draft", "on_hold", "rejected", "pending", "under_review"].includes(onboarding.status || "")) {
        return res.status(400).json({ error: "Cannot submit onboarding request in current status" });
      }

      // No strict field/document validation - admin reviews submissions during verification

      const updated = await storage.updateCarrierVerification(onboarding.id, {
        status: "pending",
        submittedAt: new Date(),
      });

      // Ensure carrierType is synced to carrierProfiles on submission
      if (onboarding.carrierType) {
        const profile = await storage.getCarrierProfile(user.id);
        if (profile) {
          // Properly parse fleetSize - solo drivers always have 1, enterprise use existing or 0
          const newFleetSize = onboarding.carrierType === "solo" 
            ? 1 
            : (typeof onboarding.fleetSize === 'number' 
                ? onboarding.fleetSize 
                : (typeof profile.fleetSize === 'number' ? profile.fleetSize : 0));
          await storage.updateCarrierProfile(user.id, { 
            carrierType: onboarding.carrierType,
            fleetSize: newFleetSize
          });
        }
      }

      const updatedDocs = await storage.getVerificationDocuments(onboarding.id);
      res.json({ ...updated, documents: updatedDocs });
    } catch (error) {
      console.error("Submit carrier onboarding error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/carrier/verification - Get carrier's own verification status
  app.get("/api/carrier/verification", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      const verification = await storage.getCarrierVerificationByCarrier(user.id);
      if (!verification) {
        return res.json(null);
      }

      const documents = await storage.getVerificationDocuments(verification.id);
      res.json({ ...verification, documents });
    } catch (error) {
      console.error("Get carrier verification error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/carrier/verification/documents - Upload verification document
  app.post("/api/carrier/verification/documents", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      const verification = await storage.getCarrierVerificationByCarrier(user.id);
      if (!verification) {
        return res.status(400).json({ error: "No verification request found. Please submit a verification request first." });
      }

      // Extended schema with all carrier verification document types
      const userInputSchema = z.object({
        documentType: z.enum([
          // Solo operator documents
          "aadhaar", "license", "permit", "rc", "insurance", "fitness", "selfie",
          // Fleet/Company documents
          "incorporation", "trade_license", "address_proof", "pan", "gstin", "tan", "cin",
          // Bank documents
          "void_cheque",
          // Tax documents
          "tds_declaration",
          // MSME / Udyam certificate
          "msme_udyam", "msme", "udyam",
          // Legacy types
          "gst", "aadhar", "fleet_proof", "other"
        ]),
        fileName: z.string().min(1),
        fileUrl: z.string().min(1),
        fileSize: z.number().int().optional(),
        expiryDate: z.string().optional(),
      });

      const userInput = userInputSchema.parse(req.body);

      // Build final payload - server controls verificationId and carrierId
      const document = await storage.createVerificationDocument({
        verificationId: verification.id,
        carrierId: user.id,
        documentType: userInput.documentType,
        fileName: userInput.fileName,
        fileUrl: userInput.fileUrl,
        fileSize: userInput.fileSize,
        expiryDate: userInput.expiryDate ? new Date(userInput.expiryDate) : null,
      });

      res.json(document);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Upload verification document error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ==================== BID NEGOTIATION ROUTES ====================

  // GET /api/bids/:id/negotiations - Get bid negotiation history
  app.get("/api/bids/:id/negotiations", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const bid = await storage.getBid(req.params.id);
      if (!bid) {
        return res.status(404).json({ error: "Bid not found" });
      }

      const load = await storage.getLoad(bid.loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      // Authorization: Only bid carrier, load shipper, or admin can view negotiations
      const isCarrier = user.id === bid.carrierId;
      const isShipper = user.id === load.shipperId;
      const isAdmin = user.role === "admin";

      if (!isCarrier && !isShipper && !isAdmin) {
        return res.status(403).json({ error: "Not authorized to view these negotiations" });
      }

      const negotiations = await storage.getBidNegotiations(req.params.id);
      
      // Enrich with sender info
      const enrichedNegotiations = await Promise.all(
        negotiations.map(async (n) => {
          const sender = n.senderId ? await storage.getUser(n.senderId) : null;
          return {
            ...n,
            sender: sender ? { username: sender.username, companyName: sender.companyName } : null,
          };
        })
      );

      res.json(enrichedNegotiations);
    } catch (error) {
      console.error("Get bid negotiations error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/bids/:id/negotiate - Add negotiation message/counter offer
  app.post("/api/bids/:id/negotiate", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const bid = await storage.getBid(req.params.id);
      if (!bid) {
        return res.status(404).json({ error: "Bid not found" });
      }

      const load = await storage.getLoad(bid.loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      // Authorization: Only bid carrier, load shipper, or admin can negotiate
      const isCarrier = user.id === bid.carrierId;
      const isShipper = user.id === load.shipperId;
      const isAdmin = user.role === "admin";

      if (!isCarrier && !isShipper && !isAdmin) {
        return res.status(403).json({ error: "Not authorized to negotiate on this bid" });
      }

      // Strict schema - ONLY user-controlled fields
      const userInputSchema = z.object({
        messageType: z.enum(["message", "counter_offer", "accept", "reject"]).optional().default("message"),
        message: z.string().optional(),
        amount: z.string().optional(),
      });

      const userInput = userInputSchema.parse(req.body);

      // Extract price from message text if no explicit amount provided
      // This enables real-time margin updates when users mention prices in chat
      let extractedAmount = userInput.amount;
      if (!extractedAmount && userInput.message) {
        // Match Indian price formats: Rs. 95,000 or ₹95000 or 95,000 or 95000
        const pricePatterns = [
          /(?:Rs\.?\s*|₹\s*)?(\d{1,3}(?:,\d{2,3})*(?:\.\d{2})?)/gi,  // Rs. 95,000 or ₹95,000 or 95,000
          /(\d+(?:,\d{3})*(?:\.\d{2})?)/g  // Plain numbers like 95000 or 95,000
        ];
        
        for (const pattern of pricePatterns) {
          const matches = userInput.message.match(pattern);
          if (matches && matches.length > 0) {
            // Get the last mentioned price (most likely the proposed price)
            const lastMatch = matches[matches.length - 1];
            // Remove Rs., ₹ prefix and commas to get numeric value
            const numericValue = lastMatch.replace(/[Rs.₹,\s]/gi, "");
            const parsedValue = parseFloat(numericValue);
            // Only accept reasonable freight prices (between 1000 and 10000000)
            if (parsedValue >= 1000 && parsedValue <= 10000000) {
              extractedAmount = parsedValue.toString();
              break;
            }
          }
        }
      }

      // Build final payload - server controls senderId and senderRole from session
      const negotiation = await storage.createBidNegotiation({
        bidId: bid.id,
        loadId: bid.loadId,
        senderId: user.id,
        senderRole: user.role,
        messageType: userInput.messageType,
        message: userInput.message,
        amount: extractedAmount,
      });

      // Update bid if this is a counter offer
      if (userInput.messageType === "counter_offer" && userInput.amount) {
        await storage.updateBid(bid.id, {
          status: "countered",
          counterAmount: userInput.amount,
        });

        // Update load status if needed
        if (load.status === "open_for_bid") {
          await storage.updateLoad(load.id, { status: "counter_received" });
        }
      }

      // Broadcast negotiation message to relevant parties (include extracted amount for real-time margin)
      const targetRole = isAdmin ? "carrier" : "admin";
      const targetUserId = isAdmin ? bid.carrierId : null;
      broadcastNegotiationMessage(targetRole, targetUserId, bid.id, {
        id: negotiation.id,
        senderRole: user.role,
        message: userInput.message,
        amount: extractedAmount,  // Include extracted amount for real-time margin calculation
        counterAmount: extractedAmount,
        createdAt: negotiation.createdAt,
      });

      res.json(negotiation);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Create bid negotiation error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ==================== INVOICE RESPONSE ROUTES ====================

  // GET /api/invoices/:id/responses - Get invoice responses/negotiation history
  app.get("/api/invoices/:id/responses", requireAuth, async (req, res) => {
    try {
      const responses = await storage.getShipperInvoiceResponses(req.params.id);
      res.json(responses);
    } catch (error) {
      console.error("Get invoice responses error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/invoices/:id/respond - Submit shipper response to invoice
  app.post("/api/invoices/:id/respond", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const invoice = await storage.getInvoice(req.params.id);
      if (!invoice) {
        return res.status(404).json({ error: "Invoice not found" });
      }

      // Authorization: Verify shipper owns this invoice
      if (user.role !== "shipper" || user.id !== invoice.shipperId) {
        return res.status(403).json({ error: "Not authorized to respond to this invoice" });
      }

      // Validate allowed status transitions
      const allowedStatusesForResponse = ["pending", "sent", "viewed", "negotiating", "disputed"];
      if (!allowedStatusesForResponse.includes(invoice.status || '')) {
        return res.status(400).json({ error: `Cannot respond to invoice in ${invoice.status} status` });
      }

      // Strict schema - ONLY user-controlled fields
      const userInputSchema = z.object({
        responseType: z.enum(["approve", "negotiate", "query"]),
        message: z.string().optional(),
        counterAmount: z.string().optional(),
      });

      const userInput = userInputSchema.parse(req.body);

      // Build final payload - server controls invoiceId, loadId, shipperId
      const response = await storage.createShipperInvoiceResponse({
        invoiceId: invoice.id,
        loadId: invoice.loadId || "",
        shipperId: user.id,
        responseType: userInput.responseType,
        message: userInput.message,
        counterAmount: userInput.counterAmount,
      });

      // Update invoice status based on response type - server-controlled transitions
      if (userInput.responseType === "approve") {
        await storage.updateInvoice(invoice.id, {
          status: "approved",
          approvedAt: new Date(),
          shipperResponseType: "approve",
        });
      } else if (userInput.responseType === "negotiate") {
        await storage.updateInvoice(invoice.id, {
          status: "negotiating",
          shipperResponseType: "negotiate",
          shipperCounterAmount: userInput.counterAmount,
          shipperResponseMessage: userInput.message,
        });
      } else if (userInput.responseType === "query") {
        await storage.updateInvoice(invoice.id, {
          status: "disputed",
          shipperResponseType: "query",
          shipperResponseMessage: userInput.message,
        });
      }

      // Create invoice history entry
      await storage.createInvoiceHistory({
        invoiceId: invoice.id,
        userId: user.id,
        action: `shipper_${userInput.responseType}`,
        payload: { message: userInput.message, counterAmount: userInput.counterAmount },
      });

      res.json(response);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.errors });
      }
      console.error("Submit invoice response error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/invoices/:id/respond - Admin responds to shipper query/negotiation
  app.post("/api/admin/invoices/:id/respond", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const invoice = await storage.getInvoice(req.params.id);
      if (!invoice) {
        return res.status(404).json({ error: "Invoice not found" });
      }

      // Get the pending response
      const responses = await storage.getShipperInvoiceResponses(invoice.id);
      const pendingResponse = responses.find((r) => r.status === "pending");

      if (pendingResponse) {
        await storage.updateShipperInvoiceResponse(pendingResponse.id, {
          status: "resolved",
          adminResponse: req.body.message,
          adminRespondedAt: new Date(),
          adminId: user.id,
        });
      }

      // Update invoice based on admin action
      if (req.body.action === "accept_counter") {
        await storage.updateInvoice(invoice.id, {
          totalAmount: req.body.newAmount || invoice.shipperCounterAmount,
          status: "approved",
          approvedAt: new Date(),
        });
      } else if (req.body.action === "reject_counter") {
        await storage.updateInvoice(invoice.id, {
          status: "sent", // Back to sent status for re-review
        });
      }

      // Create audit log
      await storage.createAuditLog({
        adminId: user.id,
        actionType: "invoice_response",
        actionDescription: `Admin responded to invoice ${invoice.invoiceNumber}: ${req.body.action}`,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
        metadata: { invoiceId: invoice.id, action: req.body.action },
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Admin invoice response error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =============================================
  // LOAD STATE TRANSITION ENDPOINT
  // =============================================

  // POST /api/loads/:id/transition - Transition load to new state
  app.post("/api/loads/:id/transition", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { toStatus, reason } = req.body;
      if (!toStatus) {
        return res.status(400).json({ error: "toStatus is required" });
      }

      const load = await storage.getLoad(req.params.id);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      // Authorization: Only admins, the shipper who owns, or assigned carrier can transition
      const isAdmin = user.role === "admin";
      const isOwner = user.id === load.shipperId;
      const isAssignedCarrier = user.id === load.assignedCarrierId;

      if (!isAdmin && !isOwner && !isAssignedCarrier) {
        return res.status(403).json({ error: "Not authorized to transition this load" });
      }

      // Use the canonical state transition function
      const result = await transitionLoadState(load.id, toStatus, user.id, reason);
      
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      const updatedLoad = await storage.getLoad(load.id);
      
      // Broadcast status change to admin portal for real-time sync
      if (updatedLoad) {
        const eventType = toStatus === 'unavailable' ? 'load_unavailable' : 
                          toStatus === 'pending' ? 'load_available' : 
                          `load_status_${toStatus}`;
        broadcastLoadUpdated(updatedLoad.id, updatedLoad.shipperId, updatedLoad.status, eventType, {
          id: updatedLoad.id,
          status: updatedLoad.status,
          pickupCity: updatedLoad.pickupCity,
          dropoffCity: updatedLoad.dropoffCity,
          previousStatus: load.status,
          changedBy: user.role,
        });
      }
      
      res.json({ success: true, load: updatedLoad });
    } catch (error) {
      console.error("Load transition error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =============================================
  // SETTLEMENTS ENDPOINTS
  // =============================================

  // GET /api/settlements - Get all settlements (admin)
  app.get("/api/settlements", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const settlements = await storage.getAllSettlements();
      res.json(settlements);
    } catch (error) {
      console.error("Get settlements error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/settlements/carrier - Get settlements for current carrier
  app.get("/api/settlements/carrier", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      const settlements = await storage.getSettlementsByCarrier(user.id);
      res.json(settlements);
    } catch (error) {
      console.error("Get carrier settlements error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/settlements - Create settlement (admin)
  app.post("/api/settlements", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const settlement = await storage.createSettlement(req.body);
      res.json(settlement);
    } catch (error) {
      console.error("Create settlement error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /api/settlements/:id - Update settlement status
  app.patch("/api/settlements/:id", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const settlement = await storage.updateSettlement(req.params.id, req.body);
      res.json(settlement);
    } catch (error) {
      console.error("Update settlement error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =============================================
  // CARRIER VERIFICATION ENDPOINTS
  // =============================================

  // GET /api/carrier-verifications - Get all pending verifications (admin)
  app.get("/api/carrier-verifications", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const verifications = await storage.getAllCarrierVerifications();
      res.json(verifications);
    } catch (error) {
      console.error("Get verifications error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/carrier-verifications/:carrierId - Get verification for specific carrier
  app.get("/api/carrier-verifications/:carrierId", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // Allow admin or the carrier themselves
      if (user.role !== "admin" && user.id !== req.params.carrierId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const verification = await storage.getCarrierVerification(req.params.carrierId);
      res.json(verification || null);
    } catch (error) {
      console.error("Get verification error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /api/carrier-verifications/:id - Update verification status (admin)
  app.patch("/api/carrier-verifications/:id", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const verification = await storage.updateCarrierVerification(req.params.id, req.body);
      res.json(verification);
    } catch (error) {
      console.error("Update verification error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =============================================
  // CARRIERS ENDPOINTS (PUBLIC DATA)
  // =============================================

  // GET /api/carriers - Get all verified carriers
  app.get("/api/carriers", requireAuth, async (req, res) => {
    try {
      const allUsers = await storage.getAllUsers();
      const carriers = allUsers.filter(u => u.role === "carrier" && u.isVerified);
      
      const carriersWithProfiles = await Promise.all(
        carriers.map(async (carrier) => {
          const profile = await storage.getCarrierProfile(carrier.id);
          const { password: _, ...carrierWithoutPassword } = carrier;
          return { ...carrierWithoutPassword, carrierProfile: profile };
        })
      );

      res.json(carriersWithProfiles);
    } catch (error) {
      console.error("Get carriers error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/carriers/:id - Get specific carrier details
  app.get("/api/carriers/:id", requireAuth, async (req, res) => {
    try {
      const carrier = await storage.getUser(req.params.id);
      if (!carrier || carrier.role !== "carrier") {
        return res.status(404).json({ error: "Carrier not found" });
      }

      const profile = await storage.getCarrierProfile(carrier.id);
      const { password: _, ...carrierWithoutPassword } = carrier;
      res.json({ ...carrierWithoutPassword, carrierProfile: profile });
    } catch (error) {
      console.error("Get carrier error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =============================================
  // NOTIFICATIONS ENDPOINTS
  // =============================================

  // GET /api/notifications - Get notifications for current user
  app.get("/api/notifications", requireAuth, async (req, res) => {
    try {
      const notifications = await storage.getNotificationsByUser(req.session.userId!);
      const loadIds = [...new Set(notifications.filter(n => n.relatedLoadId).map(n => n.relatedLoadId!))];
      const loadMap = new Map<string, string>();
      for (const lid of loadIds) {
        try {
          const load = await storage.getLoad(lid);
          if (load) {
            const num = load.shipperLoadNumber || (load as any).adminReferenceNumber;
            if (num) loadMap.set(lid, `LD-${String(num).padStart(3, '0')}`);
          }
        } catch {}
      }
      const enriched = notifications.map(n => ({
        ...n,
        loadDisplayId: n.relatedLoadId ? (loadMap.get(n.relatedLoadId) || null) : null,
      }));
      res.json(enriched);
    } catch (error) {
      console.error("Get notifications error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /api/notifications/:id/read - Mark notification as read
  app.patch("/api/notifications/:id/read", requireAuth, async (req, res) => {
    try {
      const notification = await storage.getNotification(req.params.id);
      if (!notification) {
        return res.status(404).json({ error: "Notification not found" });
      }

      if (notification.userId !== req.session.userId) {
        return res.status(403).json({ error: "Access denied" });
      }

      await storage.markNotificationAsRead(req.params.id);
      res.json({ success: true });
    } catch (error) {
      console.error("Mark notification read error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/notifications/read-all - Mark all notifications as read
  app.post("/api/notifications/read-all", requireAuth, async (req, res) => {
    try {
      await storage.markAllNotificationsAsRead(req.session.userId!);
      res.json({ success: true });
    } catch (error) {
      console.error("Mark all notifications read error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =============================================
  // SHIPMENTS ENDPOINTS
  // =============================================

  // GET /api/shipments - Get all shipments (admin) or user's shipments
  app.get("/api/shipments", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      let shipments;
      if (user.role === "admin") {
        shipments = await storage.getAllShipments();
      } else if (user.role === "carrier") {
        shipments = await storage.getShipmentsByCarrier(user.id);
      } else {
        shipments = await storage.getShipmentsByShipper(user.id);
      }

      res.json(shipments);
    } catch (error) {
      console.error("Get shipments error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/shipments/tracking - Get enriched shipments for tracking (shipper/carrier)
  // NOTE: This must be defined BEFORE /api/shipments/:id to prevent "tracking" matching as an id
  app.get("/api/shipments/tracking", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      let shipmentsList: any[] = [];
      
      if (user.role === "shipper") {
        shipmentsList = await storage.getShipmentsByShipper(user.id);
      } else if (user.role === "carrier") {
        shipmentsList = await storage.getShipmentsByCarrier(user.id);
      } else if (user.role === "admin") {
        shipmentsList = await storage.getAllShipments();
      }

      // Enrich each shipment with load, carrier, truck, driver details
      const enrichedShipments = await Promise.all(
        shipmentsList.map(async (shipment) => {
          const load = await storage.getLoad(shipment.loadId);
          const carrier = await storage.getUser(shipment.carrierId);
          const carrierProfile = carrier ? await storage.getCarrierProfile(carrier.id) : null;
          const events = await storage.getShipmentEvents(shipment.id);
          const loadDocuments = await storage.getDocumentsByLoad(shipment.loadId);
          const shipmentDocuments = await storage.getDocumentsByShipment(shipment.id);
          const documents = [...loadDocuments, ...shipmentDocuments.filter(d => !loadDocuments.find(ld => ld.id === d.id))];
          
          // Get truck - try shipment first, then load's assigned truck, then bid's truck, then carrier's first truck
          let truck = null;
          if (shipment.truckId) {
            truck = await storage.getTruck(shipment.truckId);
          } else if (load?.assignedTruckId) {
            truck = await storage.getTruck(load.assignedTruckId);
          } else if (load?.awardedBidId) {
            const bid = await storage.getBid(load.awardedBidId);
            if (bid?.truckId) {
              truck = await storage.getTruck(bid.truckId);
            }
          }
          // For solo carriers without truck, get their first truck
          if (!truck && carrier) {
            const carrierTrucks = await storage.getTrucksByCarrier(carrier.id);
            if (carrierTrucks.length > 0) {
              truck = carrierTrucks[0];
            }
          }
          
          // Get driver info - for enterprise carriers, get assigned driver; for solo, carrier is the driver
          const carrierType = carrierProfile?.carrierType || 'solo';
          let driverInfo: { name: string; phone: string | null } | null = null;
          
          if (carrierType === 'solo') {
            // Solo driver - the carrier IS the driver
            driverInfo = {
              name: carrier?.username || 'Unknown',
              phone: carrier?.phone || null,
            };
          } else if (shipment.driverId) {
            // Enterprise carrier with assigned driver
            const driver = await storage.getDriver(shipment.driverId);
            if (driver) {
              driverInfo = {
                name: driver.name,
                phone: driver.phone || null,
              };
            }
          }
          
          // Get trips completed for this carrier
          const allCarrierShipments = await storage.getShipmentsByCarrier(shipment.carrierId);
          const tripsCompleted = allCarrierShipments.filter(s => 
            s.endOtpVerified || s.status === 'delivered'
          ).length;

          // Calculate progress based on shipment status and OTP verification
          let progress = 0;
          let currentStage = "load_created";
          
          if (shipment.startOtpVerified && shipment.endOtpVerified) {
            progress = 100;
            currentStage = "delivered";
          } else if (shipment.status === "in_transit" || shipment.startOtpVerified) {
            progress = 60;
            currentStage = "in_transit";
          } else if (shipment.status === "pickup_scheduled") {
            progress = 25;
            currentStage = "carrier_assigned";
          }

          // Build timeline events from shipment state and actual events
          const timeline = [];
          
          // Load Created - always exists
          timeline.push({
            stage: "load_created",
            completed: true,
            timestamp: load?.createdAt || shipment.createdAt,
            location: load?.pickupCity || "Origin",
          });

          // Carrier Assigned - always true if shipment exists
          timeline.push({
            stage: "carrier_assigned",
            completed: true,
            timestamp: shipment.createdAt,
            location: load?.pickupCity || "Origin",
          });

          // Reached Pickup - tied to start OTP request
          timeline.push({
            stage: "reached_pickup",
            completed: shipment.startOtpRequested || false,
            timestamp: shipment.startOtpRequestedAt || null,
            location: load?.pickupCity || "Pickup Location",
          });

          // Loaded - tied to start OTP verification
          timeline.push({
            stage: "loaded",
            completed: shipment.startOtpVerified || false,
            timestamp: shipment.startOtpVerifiedAt || null,
            location: load?.pickupCity || "Pickup Location",
          });

          // In Transit
          timeline.push({
            stage: "in_transit",
            completed: shipment.startOtpVerified || false,
            timestamp: shipment.startedAt || shipment.startOtpVerifiedAt || null,
            location: "En Route",
          });

          // Arrived at Drop - tied to end OTP request
          timeline.push({
            stage: "arrived_at_drop",
            completed: shipment.endOtpRequested || false,
            timestamp: shipment.endOtpRequestedAt || null,
            location: load?.dropoffCity || "Delivery Location",
          });

          // Delivered - tied to end OTP verification
          timeline.push({
            stage: "delivered",
            completed: shipment.endOtpVerified || false,
            timestamp: shipment.endOtpVerifiedAt || shipment.completedAt || null,
            location: load?.dropoffCity || "Delivery Location",
          });

          return {
            ...shipment,
            load: load ? {
              id: load.id,
              // loadNumber: load.loadNumber, // Field removed from schema
              shipperLoadNumber: load.shipperLoadNumber,
              adminReferenceNumber: load.adminReferenceNumber,
              pickupCity: load.pickupCity,
              pickupAddress: load.pickupAddress,
              pickupLocality: load.pickupLocality,
              pickupLandmark: load.pickupLandmark,
              pickupState: load.pickupState,
              pickupLat: load.pickupLat,
              pickupLng: load.pickupLng,
              pickupDate: load.pickupDate,
              dropoffCity: load.dropoffCity,
              dropoffAddress: load.dropoffAddress,
              dropoffLocality: load.dropoffLocality,
              dropoffLandmark: load.dropoffLandmark,
              dropoffState: load.dropoffState,
              dropoffLat: load.dropoffLat,
              dropoffLng: load.dropoffLng,
              materialType: load.materialType,
              weight: load.weight,
              requiredTruckType: load.requiredTruckType,
              finalPrice: load.finalPrice,
              adminFinalPrice: load.adminFinalPrice,
              shipperId: load.shipperId,
              cargoType: load.goodsToBeCarried,
              distance: load.distance,
            } : null,
            carrier: carrier ? {
              id: carrier.id,
              username: carrier.username,
              companyName: carrierProfile?.companyName || carrier.companyName || carrier.username,
              phone: carrier.phone,
              carrierType: carrierType,
              tripsCompleted: tripsCompleted,
            } : null,
            driver: driverInfo,
            truck: truck ? {
              id: truck.id,
              registrationNumber: truck.licensePlate,
              truckType: truck.truckType,
              capacity: truck.capacity,
            } : null,
            events,
            documents: documents.map(d => ({
              id: d.id,
              documentType: d.documentType,
              status: d.isVerified ? "verified" : "pending",
              fileName: d.fileName,
              fileUrl: d.fileUrl,
            })),
            timeline,
            progress,
            currentStage,
          };
        })
      );

      res.json(enrichedShipments);
    } catch (error) {
      console.error("Get tracking shipments error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/shipments/:id/tracking - Get single enriched shipment for tracking
  app.get("/api/shipments/:id/tracking", requireAuth, async (req, res) => {
    try {
      const shipment = await storage.getShipment(req.params.id);
      if (!shipment) {
        return res.status(404).json({ error: "Shipment not found" });
      }

      const load = await storage.getLoad(shipment.loadId);
      const carrier = await storage.getUser(shipment.carrierId);
      const carrierProfile = carrier ? await storage.getCarrierProfile(carrier.id) : null;
      const truck = shipment.truckId ? await storage.getTruck(shipment.truckId) : null;
      const events = await storage.getShipmentEvents(shipment.id);
      const loadDocuments = await storage.getDocumentsByLoad(shipment.loadId);
      const shipmentDocuments = await storage.getDocumentsByShipment(shipment.id);
      const documents = [...loadDocuments, ...shipmentDocuments.filter(d => !loadDocuments.find(ld => ld.id === d.id))];

      // Calculate progress
      let progress = 0;
      let currentStage = "load_created";
      
      if (shipment.startOtpVerified && shipment.endOtpVerified) {
        progress = 100;
        currentStage = "delivered";
      } else if (shipment.status === "in_transit" || shipment.startOtpVerified) {
        progress = 60;
        currentStage = "in_transit";
      } else if (shipment.status === "pickup_scheduled") {
        progress = 25;
        currentStage = "carrier_assigned";
      }

      // Build timeline
      const timeline = [
        {
          stage: "load_created",
          completed: true,
          timestamp: load?.createdAt || shipment.createdAt,
          location: load?.pickupCity || "Origin",
        },
        {
          stage: "carrier_assigned",
          completed: true,
          timestamp: shipment.createdAt,
          location: load?.pickupCity || "Origin",
        },
        {
          stage: "reached_pickup",
          completed: shipment.startOtpRequested || false,
          timestamp: shipment.startOtpRequestedAt || null,
          location: load?.pickupCity || "Pickup Location",
        },
        {
          stage: "loaded",
          completed: shipment.startOtpVerified || false,
          timestamp: shipment.startOtpVerifiedAt || null,
          location: load?.pickupCity || "Pickup Location",
        },
        {
          stage: "in_transit",
          completed: shipment.startOtpVerified || false,
          timestamp: shipment.startedAt || shipment.startOtpVerifiedAt || null,
          location: "En Route",
        },
        {
          stage: "arrived_at_drop",
          completed: shipment.endOtpRequested || false,
          timestamp: shipment.endOtpRequestedAt || null,
          location: load?.dropoffCity || "Delivery Location",
        },
        {
          stage: "delivered",
          completed: shipment.endOtpVerified || false,
          timestamp: shipment.endOtpVerifiedAt || shipment.completedAt || null,
          location: load?.dropoffCity || "Delivery Location",
        },
      ];

      res.json({
        ...shipment,
        load: load ? {
          id: load.id,
          adminReferenceNumber: load.adminReferenceNumber,
          pickupCity: load.pickupCity,
          pickupAddress: load.pickupAddress,
          dropoffCity: load.dropoffCity,
          dropoffAddress: load.dropoffAddress,
          materialType: load.materialType,
          weight: load.weight,
          requiredTruckType: load.requiredTruckType,
        } : null,
        carrier: carrier ? {
          id: carrier.id,
          username: carrier.username,
          companyName: carrier.companyName || carrier.username,
          phone: carrier.phone,
        } : null,
        truck: truck ? {
          id: truck.id,
          registrationNumber: truck.licensePlate,
          truckType: truck.truckType,
          capacity: truck.capacity,
        } : null,
        events,
        documents: documents.map(d => ({
          id: d.id,
          documentType: d.documentType,
          status: d.isVerified ? "verified" : "pending",
          fileName: d.fileName,
        })),
        timeline,
        progress,
        currentStage,
      });
    } catch (error) {
      console.error("Get tracking shipment error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/shipments/load/:loadId - Get shipment for a load with carrier, truck, driver details
  app.get("/api/shipments/load/:loadId", requireAuth, async (req, res) => {
    try {
      const shipment = await storage.getShipmentByLoad(req.params.loadId);
      if (!shipment) {
        return res.json(null);
      }

      // Include carrier, truck, and driver details for Carrier Memo display
      const carrier = await storage.getUser(shipment.carrierId);
      
      // Get carrier profile to determine carrier type
      const carrierProfile = carrier ? await storage.getCarrierProfile(carrier.id) : null;
      const isSoloCarrier = carrierProfile?.carrierType === 'solo';
      
      // Get truck - if not on shipment, for solo carriers get their registered truck
      let truck = shipment.truckId ? await storage.getTruck(shipment.truckId) : null;
      if (!truck && carrier) {
        // Fallback: get the carrier's truck(s) - solo carriers typically have one
        const carrierTrucks = await storage.getTrucksByCarrier(carrier.id);
        if (carrierTrucks && carrierTrucks.length > 0) {
          truck = carrierTrucks[0]; // Use their first/primary truck
        }
      }
      
      // Get driver info - for solo carriers, the carrier IS the driver
      let driverInfo = null;
      
      if (isSoloCarrier && carrier) {
        // For solo carriers, always use the carrier as the driver (they drive their own truck)
        driverInfo = {
          id: carrier.id,
          username: carrier.companyName || carrier.username,
          phone: carrier.phone,
          licenseNumber: null
        };
      } else if (shipment.driverId) {
        // For enterprise carriers, get the assigned driver
        const driver = await storage.getDriver(shipment.driverId);
        if (driver) {
          driverInfo = {
            id: driver.id,
            username: driver.name,
            phone: driver.phone,
            licenseNumber: driver.licenseNumber
          };
        }
      }

      res.json({
        ...shipment,
        carrier: carrier ? {
          id: carrier.id,
          company: carrier.companyName,
          username: carrier.username,
          phone: carrier.phone,
          email: carrier.email,
          isVerified: carrier.isVerified
        } : null,
        truck: truck ? {
          id: truck.id,
          licensePlate: truck.licensePlate,
          manufacturer: truck.make,
          model: truck.model,
          truckType: truck.truckType,
          capacity: truck.capacity
        } : null,
        driver: driverInfo
      });
    } catch (error) {
      console.error("Get shipment by load error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/shipments/:id - Get specific shipment
  // NOTE: This must be defined AFTER /api/shipments/tracking and /api/shipments/load/:loadId
  app.get("/api/shipments/:id", requireAuth, async (req, res) => {
    try {
      const shipment = await storage.getShipment(req.params.id);
      if (!shipment) {
        return res.status(404).json({ error: "Shipment not found" });
      }
      res.json(shipment);
    } catch (error) {
      console.error("Get shipment error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /api/shipments/:id/assign-driver - Assign driver to shipment (enterprise carriers only)
  app.patch("/api/shipments/:id/assign-driver", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      // Only enterprise carriers can assign drivers - check carrier_profiles table
      const carrierProfile = await storage.getCarrierProfile(user.id);
      if (!carrierProfile || carrierProfile.carrierType !== "enterprise") {
        return res.status(403).json({ error: "Driver assignment is only available for enterprise carriers" });
      }

      const shipment = await storage.getShipment(req.params.id);
      if (!shipment) {
        return res.status(404).json({ error: "Shipment not found" });
      }

      // Only the carrier that owns the shipment can assign drivers
      if (shipment.carrierId !== user.id) {
        return res.status(403).json({ error: "You can only assign drivers to your own shipments" });
      }

      const { driverId, truckId } = req.body;
      
      if (!driverId) {
        return res.status(400).json({ error: "Driver ID is required" });
      }

      // Validate that the driver belongs to this carrier
      const driver = await storage.getDriver(driverId);
      if (!driver || driver.carrierId !== user.id) {
        return res.status(400).json({ error: "Driver not found or does not belong to your fleet" });
      }

      // Update the shipment with driver and optionally truck
      const updatedShipment = await storage.updateShipment(req.params.id, {
        driverId,
        ...(truckId && { truckId }),
      });

      res.json(updatedShipment);
    } catch (error) {
      console.error("Assign driver error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /api/shipments/:id/assign-truck - Assign truck/vehicle to shipment (enterprise carriers only)
  app.patch("/api/shipments/:id/assign-truck", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      // Only enterprise carriers can assign trucks
      const carrierProfile = await storage.getCarrierProfile(user.id);
      if (!carrierProfile || carrierProfile.carrierType !== "enterprise") {
        return res.status(403).json({ error: "Vehicle assignment is only available for enterprise carriers" });
      }

      const shipment = await storage.getShipment(req.params.id);
      if (!shipment) {
        return res.status(404).json({ error: "Shipment not found" });
      }

      // Only the carrier that owns the shipment can assign trucks
      if (shipment.carrierId !== user.id) {
        return res.status(403).json({ error: "You can only assign vehicles to your own shipments" });
      }

      const { truckId } = req.body;
      
      if (!truckId) {
        return res.status(400).json({ error: "Vehicle ID is required" });
      }

      // Validate that the truck belongs to this carrier
      const truck = await storage.getTruck(truckId);
      if (!truck || truck.carrierId !== user.id) {
        return res.status(400).json({ error: "Vehicle not found or does not belong to your fleet" });
      }

      // Update the shipment with truck
      const updatedShipment = await storage.updateShipment(req.params.id, {
        truckId,
      });

      res.json(updatedShipment);
    } catch (error) {
      console.error("Assign truck error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =============================================
  // DOCUMENTS ENDPOINTS
  // =============================================

  // GET /api/documents - Get documents for current user
  app.get("/api/documents", requireAuth, async (req, res) => {
    try {
      const documents = await storage.getDocumentsByUser(req.session.userId!);
      res.json(documents);
    } catch (error) {
      console.error("Get documents error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/shipper/documents - Get all documents for shipper's loads + onboarding verification docs
  app.get("/api/shipper/documents", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "shipper") {
        return res.status(403).json({ error: "Shipper access required" });
      }

      // Get all loads belonging to this shipper
      const shipperLoads = await storage.getLoadsByShipper(user.id);
      
      // Collect all documents from all loads
      const allDocs: any[] = [];
      for (const load of shipperLoads) {
        const loadDocs = await storage.getDocumentsByLoad(load.id);
        for (const doc of loadDocs) {
          allDocs.push({
            ...doc,
            load: {
              shipperLoadNumber: load.shipperLoadNumber,
              adminReferenceNumber: load.adminReferenceNumber,
            },
          });
        }
      }

      // Also include shipper onboarding/verification documents
      const onboarding = await storage.getShipperOnboardingRequest(user.id);
      if (onboarding) {
        const docFields: Array<{ field: string; type: string; label: string }> = [
          { field: "gstCertificateUrl", type: "gst_certificate", label: "GST Certificate" },
          { field: "panCardUrl", type: "pan_card", label: "PAN Card" },
          { field: "incorporationCertificateUrl", type: "incorporation_certificate", label: "Incorporation Certificate" },
          { field: "cancelledChequeUrl", type: "cancelled_cheque", label: "Cancelled Cheque" },
          { field: "businessAddressProofUrl", type: "address_proof", label: "Business Address Proof" },
          { field: "selfieUrl", type: "selfie", label: "Selfie Verification" },
          { field: "msmeUrl", type: "msme_certificate", label: "MSME/Udyam Certificate" },
          { field: "udyamUrl", type: "udyam_certificate", label: "Udyam Registration" },
          { field: "lrCopyUrl", type: "lr_copy", label: "LR Copy" },
          { field: "alternativeAuthorizationUrl", type: "alternative_authorization", label: "Alternative Authorization" },
        ];

        for (const docField of docFields) {
          const url = (onboarding as any)[docField.field];
          if (url) {
            const fileName = url.split("/").pop() || docField.label;
            allDocs.push({
              id: `onboarding-${docField.field}`,
              userId: user.id,
              loadId: null,
              shipmentId: null,
              documentType: docField.type,
              fileName: docField.label,
              fileUrl: url,
              fileSize: null,
              isVerified: onboarding.status === "approved",
              createdAt: onboarding.submittedAt || onboarding.updatedAt,
              load: null,
              isOnboardingDoc: true,
            });
          }
        }
      }

      // Sort by creation date (newest first)
      allDocs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      res.json(allDocs);
    } catch (error) {
      console.error("Get shipper documents error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/loads/:loadId/documents - Get documents for a load
  app.get("/api/loads/:loadId/documents", requireAuth, async (req, res) => {
    try {
      const documents = await storage.getDocumentsByLoad(req.params.loadId);
      res.json(documents);
    } catch (error) {
      console.error("Get load documents error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/shipments/:id/documents - Get documents for a shipment
  app.get("/api/shipments/:id/documents", requireAuth, async (req, res) => {
    try {
      const shipment = await storage.getShipment(req.params.id);
      if (!shipment) {
        return res.status(404).json({ error: "Shipment not found" });
      }
      
      // Get documents linked to this shipment
      const shipmentDocs = await storage.getDocumentsByShipment(req.params.id);
      // Also get documents linked to the load
      const loadDocs = await storage.getDocumentsByLoad(shipment.loadId);
      
      // Combine and deduplicate by ID
      const allDocs = [...shipmentDocs];
      loadDocs.forEach(doc => {
        if (!allDocs.find(d => d.id === doc.id)) {
          allDocs.push(doc);
        }
      });
      
      res.json(allDocs);
    } catch (error) {
      console.error("Get shipment documents error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/shipments/:id/documents - Carrier uploads document to a shipment
  app.post("/api/shipments/:id/documents", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      const shipment = await storage.getShipment(req.params.id);
      if (!shipment) {
        return res.status(404).json({ error: "Shipment not found" });
      }

      // Only the carrier that owns the shipment can upload documents
      if (shipment.carrierId !== user.id) {
        return res.status(403).json({ error: "You can only upload documents to your own shipments" });
      }

      const { documentType, fileName, fileUrl, fileSize } = req.body;

      // Validate required fields
      if (!documentType || !fileName || !fileUrl) {
        return res.status(400).json({ error: "Document type, file name, and file URL are required" });
      }

      // Validate document type
      const validDocTypes = ["lr_consignment", "eway_bill", "loading_photos", "pod", "invoice", "other"];
      if (!validDocTypes.includes(documentType)) {
        return res.status(400).json({ error: "Invalid document type" });
      }

      // Create the document linked to shipment and load
      const doc = await storage.createDocument({
        userId: user.id,
        shipmentId: req.params.id,
        loadId: shipment.loadId,
        documentType,
        fileName,
        fileUrl,
        fileSize: fileSize || null,
        isVerified: false,
      });

      // Broadcast document upload event to shipper via WebSocket
      const load = await storage.getLoad(shipment.loadId);
      if (load?.shipperId) {
        broadcastToUser(load.shipperId, {
          type: "shipment_document_uploaded",
          shipmentId: req.params.id,
          loadId: shipment.loadId,
          document: doc,
        });
        
        // Create notification for shipper about document upload
        const loadNum = load.adminReferenceNumber ?? load.shipperLoadNumber;
        const loadLabel = loadNum != null ? `LD-${String(loadNum).padStart(3, '0')}` : 'your shipment';
        const docTypeLabels: Record<string, string> = {
          'lr_consignment': 'LR/Consignment Note',
          'eway_bill': 'E-Way Bill',
          'loading_photos': 'Loading Photos',
          'pod': 'Proof of Delivery',
          'invoice': 'Invoice',
          'other': 'Document',
        };
        const docLabel = docTypeLabels[documentType] || documentType;
        await storage.createNotification({
          userId: load.shipperId,
          title: "Document Uploaded",
          message: `${user.companyName || user.username} uploaded ${docLabel} for ${loadLabel}`,
          type: "document",
          relatedLoadId: load.id,
        });
      }

      res.status(201).json(doc);
    } catch (error) {
      console.error("Upload shipment document error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =============================================
  // USERS ENDPOINT (ADMIN)
  // =============================================

  // GET /api/users - Get all users (admin only)
  app.get("/api/users", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const allUsers = await storage.getAllUsers();
      const usersWithoutPasswords = allUsers.map(u => {
        const { password: _, ...userWithoutPassword } = u;
        return userWithoutPassword;
      });
      res.json(usersWithoutPasswords);
    } catch (error) {
      console.error("Get users error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =============================================
  // INVOICES GENERAL ENDPOINTS
  // =============================================

  // GET /api/invoices - Get invoices based on user role
  app.get("/api/invoices", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      let invoices: any[] = [];
      if (user.role === "admin") {
        invoices = await storage.getAllInvoices();
      } else if (user.role === "shipper") {
        invoices = await storage.getInvoicesByShipper(user.id);
        // Filter to show only sent+ invoices to shipper
        const visibleStatuses = ['sent', 'approved', 'acknowledged', 'paid', 'overdue'];
        invoices = invoices.filter(inv => visibleStatuses.includes(inv.status || ''));
      } else if (user.role === "carrier") {
        // Carriers see invoices for loads they delivered
        const allInvoices = await storage.getAllInvoices();
        const carrierLoads = await storage.getLoadsByCarrier(user.id);
        const carrierLoadIds = carrierLoads.map(l => l.id);
        invoices = allInvoices.filter(inv => carrierLoadIds.includes(inv.loadId || ''));
      } else {
        invoices = [];
      }

      res.json(invoices);
    } catch (error) {
      console.error("Get invoices error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/invoices/:id - Get specific invoice
  app.get("/api/invoices/:id", requireAuth, async (req, res) => {
    try {
      const invoice = await storage.getInvoice(req.params.id);
      if (!invoice) {
        return res.status(404).json({ error: "Invoice not found" });
      }

      const user = await storage.getUser(req.session.userId!);
      // Authorization check
      if (user?.role !== "admin" && user?.id !== invoice.shipperId) {
        return res.status(403).json({ error: "Access denied" });
      }

      res.json(invoice);
    } catch (error) {
      console.error("Get invoice error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/invoices - Create invoice (admin only, for completed loads)
  app.post("/api/invoices", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const invoice = await storage.createInvoice(req.body);
      res.json(invoice);
    } catch (error) {
      console.error("Create invoice error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /api/invoices/:id - Update invoice
  app.patch("/api/invoices/:id", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const invoice = await storage.updateInvoice(req.params.id, req.body);
      res.json(invoice);
    } catch (error) {
      console.error("Update invoice error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/invoices/:id/send - Send invoice to shipper
  app.post("/api/invoices/:id/send", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const invoice = await storage.getInvoice(req.params.id);
      if (!invoice) {
        return res.status(404).json({ error: "Invoice not found" });
      }

      const updatedInvoice = await storage.updateInvoice(req.params.id, {
        status: 'sent',
        sentAt: new Date(),
      });

      // Notify shipper
      if (invoice.shipperId) {
        await storage.createNotification({
          userId: invoice.shipperId,
          title: "New Invoice Received",
          message: `Invoice #${invoice.invoiceNumber} is ready for your review.`,
          type: "info",
          relatedLoadId: invoice.loadId || undefined,
        });
      }

      // Update load status
      if (invoice.loadId) {
        await transitionLoadState(invoice.loadId, 'invoice_sent', user.id, 'Invoice sent to shipper');
      }

      res.json({ success: true, invoice: updatedInvoice });
    } catch (error) {
      console.error("Send invoice error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =============================================
  // LOAD HISTORY ENDPOINT
  // =============================================

  // GET /api/loads/:id/history - Get load state history
  app.get("/api/loads/:id/history", requireAuth, async (req, res) => {
    try {
      const history = await storage.getLoadStateHistory(req.params.id);
      res.json(history);
    } catch (error) {
      console.error("Get load history error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =============================================
  // NEGOTIATION THREADS ENDPOINT
  // =============================================

  // GET /api/negotiations - Get negotiation threads for current user
  app.get("/api/negotiations", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      if (user.role === "admin") {
        const threads = await storage.getAllNegotiationThreads();
        res.json(threads);
      } else {
        // Get threads for loads user is involved in
        const userLoads = user.role === "shipper" 
          ? await storage.getLoadsByShipper(user.id)
          : await storage.getLoadsByCarrier(user.id);
        
        const threads = await Promise.all(
          userLoads.map(load => storage.getNegotiationThread(load.id))
        );
        res.json(threads.filter(Boolean));
      }
    } catch (error) {
      console.error("Get negotiations error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/negotiations/:loadId - Get specific thread
  app.get("/api/negotiations/:loadId", requireAuth, async (req, res) => {
    try {
      const thread = await storage.getNegotiationThread(req.params.loadId);
      res.json(thread || null);
    } catch (error) {
      console.error("Get negotiation thread error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =============================================
  // SEED DATA ENDPOINT (FOR TESTING)
  // =============================================

  // POST /api/admin/seed-carriers - Seed test carrier data
  app.post("/api/admin/seed-carriers", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      // Indian service zones for realistic data
      const indianServiceZones = [
        "Delhi NCR", "Mumbai", "Chennai", "Bangalore", "Kolkata", "Hyderabad",
        "Pune", "Ahmedabad", "Jaipur", "Lucknow", "Chandigarh", "Coimbatore",
        "Kochi", "Vizag", "Indore", "Nagpur", "Surat", "Vadodara"
      ];

      // Sample carrier company names for creation
      const sampleCarrierNames = [
        { name: "Shree Ganesh Transport", city: "Delhi NCR" },
        { name: "Mumbai Express Cargo", city: "Mumbai" },
        { name: "Chennai Freight Services", city: "Chennai" },
        { name: "Bangalore Logistics Co", city: "Bangalore" },
        { name: "Kolkata Moving Solutions", city: "Kolkata" },
        { name: "Hyderabad Highway Haulers", city: "Hyderabad" },
      ];

      // Get all carrier users
      const allUsers = await storage.getAllUsers();
      let carriers = allUsers.filter(u => u.role === "carrier");
      
      const seededCarriers = [];
      
      // If no carriers exist, create new ones
      if (carriers.length === 0) {
        for (const sample of sampleCarrierNames) {
          const email = `${sample.name.replace(/\s+/g, "").toLowerCase()}@freight.in`;
          const existingUser = await storage.getUserByEmail(email);
          if (existingUser) continue;

          const isVerified = Math.random() > 0.3; // 70% verified
          const newCarrier = await storage.createUser({
            username: sample.name.replace(/\s+/g, ""),
            email,
            password: await hashPassword("test123"),
            role: "carrier",
            companyName: sample.name,
            phone: "+91" + Math.floor(7000000000 + Math.random() * 2999999999),
            isVerified,
          });
          carriers.push(newCarrier);
        }
      }
      
      for (const carrier of carriers) {
        // Randomly assign 2-4 service zones (always as proper array)
        const numZones = 2 + Math.floor(Math.random() * 3);
        const shuffledZones = [...indianServiceZones].sort(() => Math.random() - 0.5);
        const assignedZones: string[] = shuffledZones.slice(0, numZones);
        
        // Random fleet size 3-15 (minimum 3 for fleet operators)
        const fleetSize = 3 + Math.floor(Math.random() * 12);
        
        // Random rating between 3.5 and 5.0
        const rating = (3.5 + Math.random() * 1.5).toFixed(2);
        
        // Random reliability scores
        const reliabilityScore = (70 + Math.random() * 30).toFixed(2);
        const communicationScore = (70 + Math.random() * 30).toFixed(2);
        const onTimeScore = (75 + Math.random() * 25).toFixed(2);
        
        // Random total deliveries 10-100
        const totalDeliveries = 10 + Math.floor(Math.random() * 90);
        
        // Badge level based on deliveries
        const badgeLevel = totalDeliveries > 50 ? "gold" : totalDeliveries > 20 ? "silver" : "bronze";
        
        const profileData = {
          fleetSize,
          serviceZones: assignedZones,
          reliabilityScore,
          communicationScore,
          onTimeScore,
          totalDeliveries,
          badgeLevel,
          carrierType: fleetSize > 5 ? "fleet" : "enterprise",
          rating,
        };
        
        // Check if profile exists and update or create
        const existingProfile = await storage.getCarrierProfile(carrier.id);
        
        if (existingProfile) {
          console.log(`Updating profile for carrier ${carrier.id} with zones:`, assignedZones);
          await storage.updateCarrierProfile(carrier.id, profileData);
        } else {
          console.log(`Creating profile for carrier ${carrier.id} with zones:`, assignedZones);
          await storage.createCarrierProfile({
            userId: carrier.id,
            ...profileData,
          });
        }
        
        // Check if verification already exists
        const existingVerification = await storage.getCarrierVerificationByCarrier(carrier.id);
        
        if (!existingVerification) {
          // Create verification record
          const verification = await storage.createCarrierVerification({
            carrierId: carrier.id,
            status: carrier.isVerified ? "approved" : "pending",
            carrierType: fleetSize > 5 ? "fleet" : "solo",
            fleetSize,
            notes: `Carrier from ${assignedZones[0]} with ${fleetSize} trucks`,
            reviewedBy: carrier.isVerified ? user.id : null,
            reviewedAt: carrier.isVerified ? new Date() : null,
          });
          
          // Create verification documents
          const documentTypes = ["rc", "insurance", "fitness", "permit", "puc", "road_tax"];
          const documentStatuses = ["pending", "approved", "rejected"];
          
          for (const docType of documentTypes.slice(0, 4 + Math.floor(Math.random() * 3))) {
            const expiryDate = new Date();
            expiryDate.setMonth(expiryDate.getMonth() + Math.floor(Math.random() * 12) + 1);
            
            await storage.createVerificationDocument({
              verificationId: verification.id,
              carrierId: carrier.id,
              documentType: docType,
              fileName: `${docType.toUpperCase()}_${carrier.companyName?.replace(/\s+/g, "_") || carrier.username}.pdf`,
              fileUrl: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
              fileSize: 100000 + Math.floor(Math.random() * 500000),
              expiryDate,
              status: carrier.isVerified ? documentStatuses[Math.floor(Math.random() * 2)] : "pending",
            });
          }
        }
        
        seededCarriers.push({
          id: carrier.id,
          companyName: carrier.companyName,
          serviceZones: assignedZones,
          fleetSize,
        });
      }

      // Broadcast update to refresh carrier directories
      broadcastMarketplaceEvent("carriers_updated", {
        count: seededCarriers.length,
        message: "Carrier data has been seeded",
      });

      res.json({ 
        success: true, 
        message: `Seeded data for ${seededCarriers.length} carriers`,
        carriers: seededCarriers,
      });
    } catch (error) {
      console.error("Seed carriers error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/admin/seed-pending-verifications - Add pending verification carriers for testing
  app.post("/api/admin/seed-pending-verifications", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      // Indian service zones
      const indianZones = [
        "Delhi NCR", "Mumbai", "Chennai", "Bangalore", "Kolkata", 
        "Hyderabad", "Pune", "Ahmedabad", "Jaipur", "Lucknow"
      ];

      // Sample pending carrier data for testing
      const pendingCarriersData = [
        { name: "Bharat Logistics", email: "bharat@logistics.in", zones: ["Delhi NCR", "Jaipur", "Lucknow"], fleet: 8 },
        { name: "South Star Transport", email: "southstar@transport.in", zones: ["Chennai", "Bangalore", "Kochi"], fleet: 5 },
        { name: "Western Movers", email: "western@movers.in", zones: ["Mumbai", "Pune", "Ahmedabad"], fleet: 12 },
      ];

      const createdCarriers = [];

      for (const carrierData of pendingCarriersData) {
        // Check if carrier with this email already exists
        const existingUser = await storage.getUserByEmail(carrierData.email);
        if (existingUser) continue;

        // Create carrier user
        const newUser = await storage.createUser({
          username: carrierData.name.replace(/\s+/g, ""),
          email: carrierData.email,
          password: await hashPassword("test123"),
          role: "carrier",
          companyName: carrierData.name,
          phone: "+91" + Math.floor(7000000000 + Math.random() * 2999999999),
          isVerified: false,
        });

        // Create carrier profile
        await storage.createCarrierProfile({
          userId: newUser.id,
          fleetSize: carrierData.fleet,
          serviceZones: carrierData.zones,
          reliabilityScore: "0.00",
          communicationScore: "0.00",
          onTimeScore: "0.00",
          totalDeliveries: 0,
          badgeLevel: "bronze",
          carrierType: carrierData.fleet > 5 ? "fleet" : "enterprise",
        });

        // Create pending verification
        const verification = await storage.createCarrierVerification({
          carrierId: newUser.id,
          status: "pending",
          carrierType: carrierData.fleet > 5 ? "fleet" : "solo",
          fleetSize: carrierData.fleet,
          notes: `New carrier from ${carrierData.zones[0]} awaiting verification`,
        });

        // Create verification documents
        const documents = [
          { type: "rc", name: "Registration Certificate" },
          { type: "insurance", name: "Vehicle Insurance" },
          { type: "fitness", name: "Fitness Certificate" },
          { type: "permit", name: "Transport Permit" },
          { type: "puc", name: "PUC Certificate" },
        ];

        for (const doc of documents) {
          const expiryDate = new Date();
          expiryDate.setMonth(expiryDate.getMonth() + 6 + Math.floor(Math.random() * 12));
          
          await storage.createVerificationDocument({
            verificationId: verification.id,
            carrierId: newUser.id,
            documentType: doc.type,
            fileName: `${doc.name.replace(/\s+/g, "_")}_${carrierData.name.replace(/\s+/g, "_")}.pdf`,
            fileUrl: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
            fileSize: 150000 + Math.floor(Math.random() * 400000),
            expiryDate,
            status: "pending",
          });
        }

        createdCarriers.push({
          id: newUser.id,
          name: carrierData.name,
          email: carrierData.email,
          zones: carrierData.zones,
          fleet: carrierData.fleet,
        });
      }

      // Broadcast for real-time updates
      broadcastMarketplaceEvent("verification_pending", {
        count: createdCarriers.length,
        message: "New carriers awaiting verification",
      });

      res.json({
        success: true,
        message: `Created ${createdCarriers.length} pending verification carriers`,
        carriers: createdCarriers,
      });
    } catch (error) {
      console.error("Seed pending verifications error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ==================== OTP SECURITY GATES ====================

  // Carrier requests trip start OTP
  app.post("/api/otp/request-start", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Only carriers can request trip start OTP" });
      }

      const { shipmentId } = req.body;
      if (!shipmentId) {
        return res.status(400).json({ error: "Shipment ID is required" });
      }

      const shipment = await storage.getShipment(shipmentId);
      if (!shipment) {
        return res.status(404).json({ error: "Shipment not found" });
      }
      if (shipment.carrierId !== user.id) {
        return res.status(403).json({ error: "Not authorized for this shipment" });
      }
      if (shipment.startOtpVerified) {
        return res.status(400).json({ error: "Trip already started" });
      }

      // Check document compliance before allowing trip start
      const compliance = await checkCarrierDocumentCompliance(user.id);
      if (!compliance.compliant) {
        return res.status(403).json({ 
          error: "Document compliance issue",
          message: compliance.reason,
          expiredDocuments: compliance.expiredDocuments,
          action: "Please renew expired documents before starting the trip"
        });
      }

      // Verify load is in correct state (invoice_paid before trip can start)
      const load = await storage.getLoad(shipment.loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }
      const allowedStartStates = ["invoice_paid", "awarded", "invoice_acknowledged", "invoice_sent"];
      if (!allowedStartStates.includes(load.status || '')) {
        return res.status(400).json({ 
          error: "Cannot start trip - invoice must be sent first",
          currentStatus: load.status,
          allowedStates: allowedStartStates
        });
      }

      // Check if there's already a pending request
      const existingRequests = await storage.getOtpRequestsByShipment(shipmentId);
      const pendingStartRequest = existingRequests.find(r => r.requestType === "trip_start" && r.status === "pending");
      if (pendingStartRequest) {
        return res.status(400).json({ error: "Start OTP request already pending", requestId: pendingStartRequest.id });
      }

      // Create OTP request for admin
      const request = await storage.createOtpRequest({
        requestType: "trip_start",
        carrierId: user.id,
        shipmentId,
        loadId: shipment.loadId,
        status: "pending",
      });

      // Update shipment
      await storage.updateShipment(shipmentId, {
        startOtpRequested: true,
        startOtpRequestedAt: new Date(),
      });

      // Broadcast to admin
      broadcastMarketplaceEvent("otp_request", {
        type: "trip_start",
        requestId: request.id,
        carrierId: user.id,
        carrierName: user.companyName || user.username,
        shipmentId,
        loadId: shipment.loadId,
      });

      res.json({ 
        success: true, 
        message: "Trip start OTP requested. Admin will generate OTP shortly.",
        requestId: request.id 
      });
    } catch (error) {
      console.error("Request start OTP error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Carrier requests route start OTP (after trip start is verified)
  app.post("/api/otp/request-route-start", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Only carriers can request route start OTP" });
      }

      const { shipmentId } = req.body;
      if (!shipmentId) {
        return res.status(400).json({ error: "Shipment ID is required" });
      }

      const shipment = await storage.getShipment(shipmentId);
      if (!shipment) {
        return res.status(404).json({ error: "Shipment not found" });
      }
      if (shipment.carrierId !== user.id) {
        return res.status(403).json({ error: "Not authorized for this shipment" });
      }
      if (!shipment.startOtpVerified) {
        return res.status(400).json({ error: "Trip not started yet. Complete trip start first." });
      }
      if ((shipment as any).routeStartOtpVerified) {
        return res.status(400).json({ error: "Route already started" });
      }

      // Verify load is in correct state
      const load = await storage.getLoad(shipment.loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      // Check if there's already a pending request
      const existingRequests = await storage.getOtpRequestsByShipment(shipmentId);
      const pendingRouteStartRequest = existingRequests.find(r => r.requestType === "route_start" && r.status === "pending");
      if (pendingRouteStartRequest) {
        return res.status(400).json({ error: "Route start OTP request already pending", requestId: pendingRouteStartRequest.id });
      }

      // Create OTP request for admin
      const request = await storage.createOtpRequest({
        requestType: "route_start",
        carrierId: user.id,
        shipmentId,
        loadId: shipment.loadId,
        status: "pending",
      });

      // Update shipment
      await storage.updateShipment(shipmentId, {
        routeStartOtpRequested: true,
        routeStartOtpRequestedAt: new Date(),
      });

      // Broadcast to admin
      broadcastMarketplaceEvent("otp_request", {
        type: "route_start",
        requestId: request.id,
        carrierId: user.id,
        carrierName: user.companyName || user.username,
        shipmentId,
        loadId: shipment.loadId,
      });

      res.json({ 
        success: true, 
        message: "Route start OTP requested. Admin will generate OTP shortly.",
        requestId: request.id 
      });
    } catch (error) {
      console.error("Request route start OTP error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Carrier requests trip end OTP
  app.post("/api/otp/request-end", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Only carriers can request trip end OTP" });
      }

      const { shipmentId } = req.body;
      if (!shipmentId) {
        return res.status(400).json({ error: "Shipment ID is required" });
      }

      const shipment = await storage.getShipment(shipmentId);
      if (!shipment) {
        return res.status(404).json({ error: "Shipment not found" });
      }
      if (shipment.carrierId !== user.id) {
        return res.status(403).json({ error: "Not authorized for this shipment" });
      }
      if (!shipment.startOtpVerified) {
        return res.status(400).json({ error: "Trip not started yet" });
      }
      if (shipment.endOtpVerified) {
        return res.status(400).json({ error: "Trip already completed" });
      }

      // Verify load is in correct state (must be in_transit)
      const load = await storage.getLoad(shipment.loadId);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }
      if (load.status !== "in_transit") {
        return res.status(400).json({ 
          error: "Cannot end trip - shipment must be in transit",
          currentStatus: load.status,
          requiredStatus: "in_transit"
        });
      }

      // Check if there's already a pending request
      const existingRequests = await storage.getOtpRequestsByShipment(shipmentId);
      const pendingEndRequest = existingRequests.find(r => r.requestType === "trip_end" && r.status === "pending");
      if (pendingEndRequest) {
        return res.status(400).json({ error: "End OTP request already pending", requestId: pendingEndRequest.id });
      }

      // Create OTP request for admin
      const request = await storage.createOtpRequest({
        requestType: "trip_end",
        carrierId: user.id,
        shipmentId,
        loadId: shipment.loadId,
        status: "pending",
      });

      // Update shipment
      await storage.updateShipment(shipmentId, {
        endOtpRequested: true,
        endOtpRequestedAt: new Date(),
      });

      // Broadcast to admin
      broadcastMarketplaceEvent("otp_request", {
        type: "trip_end",
        requestId: request.id,
        carrierId: user.id,
        carrierName: user.companyName || user.username,
        shipmentId,
        loadId: shipment.loadId,
      });

      res.json({ 
        success: true, 
        message: "Trip end OTP requested. Admin will generate OTP shortly.",
        requestId: request.id 
      });
    } catch (error) {
      console.error("Request end OTP error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin gets all OTP requests (pending, approved, rejected) for record keeping
  app.get("/api/otp/requests", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      // Get all OTP requests for complete record keeping
      const allRequests = await storage.getAllOtpRequests();
      
      // Enrich with carrier and load details
      const enrichedRequests = await Promise.all(allRequests.map(async (request) => {
        const carrierUser = await storage.getUser(request.carrierId);
        const load = await storage.getLoad(request.loadId);
        const shipment = await storage.getShipment(request.shipmentId);
        const approvedByUser = request.processedBy ? await storage.getUser(request.processedBy) : null;
        const carrierProfile = carrierUser ? await storage.getCarrierProfile(carrierUser.id) : null;
        
        // Determine if solo driver
        const isSoloDriver = carrierProfile && (
          carrierProfile.fleetSize === 0 || 
          (carrierProfile.fleetSize === null && carrierProfile.carrierType === 'solo') ||
          carrierProfile.carrierType === 'solo'
        );
        
        // Get driver details
        let assignedDriver = null;
        if (!isSoloDriver && shipment?.driverId) {
          const driver = await storage.getDriver(shipment.driverId);
          if (driver) {
            assignedDriver = {
              id: driver.id,
              name: driver.name,
              phone: driver.phone,
              licenseNumber: driver.licenseNumber,
            };
          }
        }
        
        // Get truck details
        let assignedTruck = null;
        if (shipment?.truckId) {
          const truck = await storage.getTruck(shipment.truckId);
          if (truck) {
            assignedTruck = {
              id: truck.id,
              licensePlate: truck.licensePlate,
              manufacturer: truck.make || "",
              model: truck.model,
              truckType: truck.truckType,
              truckLocation: truck.currentLocation || truck.city || "Not specified",
            };
          }
        } else if (load?.assignedTruckId) {
          const truck = await storage.getTruck(load.assignedTruckId);
          if (truck) {
            assignedTruck = {
              id: truck.id,
              licensePlate: truck.licensePlate,
              manufacturer: truck.make || "",
              model: truck.model,
              truckType: truck.truckType,
              truckLocation: truck.currentLocation || truck.city || "Not specified",
            };
          }
        } else if (carrierUser) {
          // Get carrier's first available truck
          const trucks = await storage.getTrucksByCarrier(carrierUser.id);
          if (trucks.length > 0) {
            const truck = trucks[0];
            assignedTruck = {
              id: truck.id,
              licensePlate: truck.licensePlate,
              manufacturer: truck.make || "",
              model: truck.model,
              truckType: truck.truckType,
              truckLocation: truck.currentLocation || truck.city || "Not specified",
            };
          }
        }
        
        return {
          ...request,
          isSoloDriver,
          carrier: carrierUser ? {
            id: carrierUser.id,
            companyName: isSoloDriver ? undefined : (carrierProfile?.companyName || carrierUser.companyName),
            driverName: isSoloDriver ? (carrierUser.companyName || carrierUser.username) : undefined,
            username: carrierUser.username,
            email: carrierUser.email,
            phone: carrierUser.phone,
            location: isSoloDriver 
              ? (carrierProfile?.operatingRegion || carrierProfile?.city || "Not specified")
              : (carrierProfile?.city || carrierProfile?.operatingRegion || "Not specified"),
          } : null,
          assignedDriver,
          assignedTruck,
          load: load ? {
            id: load.id,
            adminReferenceNumber: load.adminReferenceNumber,
            shipperLoadNumber: load.shipperLoadNumber,
            pickupCity: load.pickupCity,
            deliveryCity: load.dropoffCity,
            dropoffCity: load.dropoffCity,
          } : null,
          shipmentStatus: shipment?.status,
          approvedBy: approvedByUser ? {
            id: approvedByUser.id,
            username: approvedByUser.username,
          } : null,
        };
      }));

      res.json(enrichedRequests);
    } catch (error) {
      console.error("Get OTP requests error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Shipper gets OTP requests for their loads with carrier details (no phone/email)
  app.get("/api/otp/shipper-requests", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "shipper") {
        return res.status(403).json({ error: "Shipper access required" });
      }

      // Get all OTP requests
      const allRequests = await storage.getAllOtpRequests();
      
      // Filter to only show requests for shipper's loads
      const shipperLoads = await storage.getLoadsByShipper(user.id);
      const shipperLoadIds = new Set(shipperLoads.map(l => l.id));
      const shipperRequests = allRequests.filter(r => shipperLoadIds.has(r.loadId));
      
      // Enrich with carrier and load details (no phone/email for privacy)
      const enrichedRequests = await Promise.all(shipperRequests.map(async (request) => {
        const carrierUser = await storage.getUser(request.carrierId);
        const load = await storage.getLoad(request.loadId);
        const shipment = await storage.getShipment(request.shipmentId);
        const approvedByUser = request.processedBy ? await storage.getUser(request.processedBy) : null;
        const carrierProfile = carrierUser ? await storage.getCarrierProfile(carrierUser.id) : null;
        
        // Determine if solo driver: fleetSize explicitly 0, or carrierType is 'solo'
        const isSoloDriver = carrierProfile && (
          carrierProfile.fleetSize === 0 || 
          (carrierProfile.fleetSize === null && carrierProfile.carrierType === 'solo') ||
          carrierProfile.carrierType === 'solo'
        );
        
        // Get driver name - for enterprise, get assigned driver from shipment; for solo, use carrier name
        let driverName = carrierUser?.companyName || carrierUser?.username;
        if (!isSoloDriver && shipment?.driverId) {
          const driver = await storage.getDriver(shipment.driverId);
          if (driver) {
            driverName = driver.name;
          }
        }
        
        // Get truck - try shipment's truck, then load's assigned truck, then carrier's first truck
        let assignedTruck = null;
        if (shipment?.truckId) {
          assignedTruck = await storage.getTruck(shipment.truckId);
        } else if (load?.assignedTruckId) {
          assignedTruck = await storage.getTruck(load.assignedTruckId);
        } else if (carrierUser) {
          const trucks = await storage.getTrucksByCarrier(carrierUser.id);
          assignedTruck = trucks.length > 0 ? trucks[0] : null;
        }
        
        return {
          ...request,
          carrier: carrierUser ? {
            id: carrierUser.id,
            companyName: isSoloDriver ? undefined : (carrierProfile?.companyName || carrierUser.companyName),
            driverName: driverName,
            username: carrierUser.username,
            isSoloDriver,
            rating: carrierProfile?.rating || "4.5",
            totalDeliveries: carrierProfile?.totalDeliveries || 0,
            badgeLevel: carrierProfile?.badgeLevel || "bronze",
            truckNumber: assignedTruck?.licensePlate || null,
            truckType: assignedTruck?.truckType || null,
          } : null,
          load: load ? {
            id: load.id,
            adminReferenceNumber: load.adminReferenceNumber,
            shipperLoadNumber: load.shipperLoadNumber,
            pickupCity: load.pickupCity,
            deliveryCity: load.dropoffCity,
            dropoffCity: load.dropoffCity,
          } : null,
          shipmentStatus: shipment?.status,
          approvedBy: approvedByUser ? {
            id: approvedByUser.id,
            username: approvedByUser.username,
          } : null,
        };
      }));

      res.json(enrichedRequests);
    } catch (error) {
      console.error("Get shipper OTP requests error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin or Shipper approves OTP request and generates OTP
  app.post("/api/otp/approve/:requestId", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || (user.role !== "admin" && user.role !== "shipper")) {
        return res.status(403).json({ error: "Admin or Shipper access required" });
      }

      const { requestId } = req.params;
      const { validityMinutes = 10 } = req.body;

      // For shippers, verify this OTP request is for their load
      const otpRequest = await storage.getOtpRequest(requestId);
      if (!otpRequest) {
        return res.status(404).json({ error: "OTP request not found" });
      }
      
      if (user.role === "shipper") {
        const load = await storage.getLoad(otpRequest.loadId);
        if (!load || load.shipperId !== user.id) {
          return res.status(403).json({ error: "You can only approve OTP requests for your own loads" });
        }
      }

      const result = await storage.approveOtpRequest(requestId, user.id, validityMinutes);

      // Broadcast OTP approval event with OTP code to carrier
      // OTP is delivered directly via WebSocket for in-app notification
      broadcastMarketplaceEvent("otp_approved", {
        requestId,
        type: result.request.requestType,
        carrierId: result.request.carrierId,
        shipmentId: result.request.shipmentId,
        expiresAt: result.otp.expiresAt,
        otpCode: result.otp.otpCode,
        validityMinutes,
      });

      // Create notification for carrier with OTP code
      await storage.createNotification({
        userId: result.request.carrierId,
        title: result.request.requestType === "trip_start" ? "Trip Start OTP Ready" : "Trip End OTP Ready",
        message: `Your OTP code is: ${result.otp.otpCode}. Valid for ${validityMinutes} minutes. Enter this code to ${result.request.requestType === "trip_start" ? "start your trip" : "complete your delivery"}.`,
        type: "info",
        isRead: false,
        contextType: "shipment",
        relatedLoadId: result.request.loadId,
      });

      res.json({ 
        success: true, 
        message: "OTP generated successfully",
        otp: {
          id: result.otp.id,
          code: result.otp.otpCode,
          expiresAt: result.otp.expiresAt,
          validityMinutes,
        }
      });
    } catch (error: any) {
      console.error("Approve OTP request error:", error);
      res.status(400).json({ error: error.message || "Failed to approve request" });
    }
  });

  // Admin regenerates OTP for an approved request
  app.post("/api/otp/regenerate/:requestId", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || (user.role !== "admin" && user.role !== "shipper")) {
        return res.status(403).json({ error: "Admin or Shipper access required" });
      }

      const { requestId } = req.params;
      const { validityMinutes = 10 } = req.body;

      // For shippers, verify this OTP request is for their load
      const otpRequest = await storage.getOtpRequest(requestId);
      if (!otpRequest) {
        return res.status(404).json({ error: "OTP request not found" });
      }
      
      if (user.role === "shipper") {
        const load = await storage.getLoad(otpRequest.loadId);
        if (!load || load.shipperId !== user.id) {
          return res.status(403).json({ error: "You can only regenerate OTP for your own loads" });
        }
      }

      const result = await storage.regenerateOtpRequest(requestId, user.id, validityMinutes);

      // Broadcast regenerated OTP event with new OTP code to carrier
      broadcastMarketplaceEvent("otp_regenerated", {
        requestId,
        type: result.request.requestType,
        carrierId: result.request.carrierId,
        shipmentId: result.request.shipmentId,
        expiresAt: result.otp.expiresAt,
        otpCode: result.otp.otpCode,
        validityMinutes,
      });

      // Create notification for carrier with new OTP code
      const typeLabel = result.request.requestType === "trip_start" 
        ? "Trip Start" 
        : result.request.requestType === "route_start"
        ? "Route Start"
        : "Trip End";
      
      await storage.createNotification({
        userId: result.request.carrierId,
        title: `New ${typeLabel} OTP Generated`,
        message: `Your new OTP code is: ${result.otp.otpCode}. Valid for ${validityMinutes} minutes. Previous codes are now invalid.`,
        type: "info",
        isRead: false,
        contextType: "shipment",
        relatedLoadId: result.request.loadId,
      });

      res.json({ 
        success: true, 
        message: "OTP regenerated successfully",
        otp: {
          id: result.otp.id,
          code: result.otp.otpCode,
          expiresAt: result.otp.expiresAt,
          validityMinutes,
        }
      });
    } catch (error: any) {
      console.error("Regenerate OTP request error:", error);
      res.status(400).json({ error: error.message || "Failed to regenerate OTP" });
    }
  });

  // Admin or Shipper rejects OTP request
  app.post("/api/otp/reject/:requestId", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || (user.role !== "admin" && user.role !== "shipper")) {
        return res.status(403).json({ error: "Admin or Shipper access required" });
      }

      const { requestId } = req.params;
      const { notes } = req.body;

      // For shippers, verify this OTP request is for their load
      const otpRequest = await storage.getOtpRequest(requestId);
      if (!otpRequest) {
        return res.status(404).json({ error: "OTP request not found" });
      }
      
      if (user.role === "shipper") {
        const load = await storage.getLoad(otpRequest.loadId);
        if (!load || load.shipperId !== user.id) {
          return res.status(403).json({ error: "You can only reject OTP requests for your own loads" });
        }
      }

      const result = await storage.rejectOtpRequest(requestId, user.id, notes);

      // Reset the OTP request flags on the shipment so carrier can retry
      // NOTE: We preserve the timestamp fields for timeline history - only reset the boolean flag
      if (result.requestType === "trip_start") {
        await storage.updateShipment(result.shipmentId, {
          startOtpRequested: false,
          // Keep startOtpRequestedAt for timeline history
        });
      } else if (result.requestType === "trip_end") {
        await storage.updateShipment(result.shipmentId, {
          endOtpRequested: false,
          // Keep endOtpRequestedAt for timeline history
        });
      }

      // Create notification for carrier
      await storage.createNotification({
        userId: result.carrierId,
        title: result.requestType === "trip_start" ? "Trip Start OTP Rejected" : "Trip End OTP Rejected",
        message: notes || "Your OTP request was rejected by admin. You can submit a new request.",
        type: "error",
        isRead: false,
        contextType: "shipment",
        relatedLoadId: result.loadId,
      });

      // Broadcast rejection event
      broadcastMarketplaceEvent("otp_rejected", {
        requestId,
        type: result.requestType,
        carrierId: result.carrierId,
        shipmentId: result.shipmentId,
      });

      res.json({ success: true, message: "OTP request rejected" });
    } catch (error: any) {
      console.error("Reject OTP request error:", error);
      res.status(400).json({ error: error.message || "Failed to reject request" });
    }
  });

  // Carrier verifies OTP and starts/ends trip
  app.post("/api/otp/verify", requireAuth, async (req, res) => {
    try {
      const { shipmentId, otpType, otpCode } = req.body;
      if (!shipmentId || !otpType || !otpCode) {
        return res.status(400).json({ error: "Shipment ID, OTP type, and OTP code are required" });
      }

      if (!["trip_start", "route_start", "trip_end"].includes(otpType)) {
        return res.status(400).json({ error: "Invalid OTP type" });
      }

      // Parallel fetch user and shipment for speed
      const [user, shipment] = await Promise.all([
        storage.getUser(req.session.userId!),
        storage.getShipment(shipmentId)
      ]);
      
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Only carriers can verify OTP" });
      }

      if (!shipment) {
        return res.status(404).json({ error: "Shipment not found" });
      }
      if (shipment.carrierId !== user.id) {
        return res.status(403).json({ error: "Not authorized for this shipment" });
      }

      const cleanOtpCode = String(otpCode).trim();
      const isDevBypass = process.env.NODE_ENV !== "production" && /^\d{6}$/.test(cleanOtpCode);

      // Find the pending OTP for this shipment
      let pendingOtp = await storage.getPendingOtpForShipment(shipmentId, otpType);
      if (!pendingOtp && isDevBypass) {
        pendingOtp = await storage.createOtpVerification({
          otpType,
          otpCode: cleanOtpCode,
          carrierId: user.id,
          shipmentId,
          loadId: shipment.loadId,
          status: "pending",
          validityMinutes: 10,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        });
      }
      if (!pendingOtp) {
        return res.status(404).json({ error: "No pending OTP found. Please request OTP first." });
      }

      // Verify the OTP
      const verifyResult = await storage.verifyOtp(pendingOtp.id, otpCode);
      if (!verifyResult.success) {
        return res.status(400).json({ error: verifyResult.message });
      }

      // Helper to run background tasks safely after response is sent
      const runBackgroundTasks = (type: string, eventData: any, notificationData: { title: string; message: string }) => {
        setImmediate(() => {
          try {
            broadcastMarketplaceEvent(type, eventData);
          } catch (err) {
            console.error(`Background broadcast error for ${type}:`, err);
          }
          storage.getLoad(shipment.loadId)
            .then(load => {
              if (load) {
                return storage.createNotification({
                  userId: load.shipperId,
                  title: notificationData.title,
                  message: notificationData.message,
                  type: "success",
                  isRead: false,
                  contextType: "shipment",
                  relatedLoadId: shipment.loadId,
                });
              }
            })
            .catch(err => console.error(`Background notification error:`, err));
        });
      };

      // Update shipment based on OTP type - respond immediately, run background tasks async
      if (otpType === "trip_start") {
        await storage.updateShipment(shipmentId, {
          startOtpVerified: true,
          startOtpVerifiedAt: new Date(),
          startedAt: new Date(),
        });

        res.json({ 
          success: true, 
          message: "Trip started successfully. Now request Route Start OTP.",
          shipmentStatus: "awaiting_route_start"
        });

        runBackgroundTasks("trip_started", {
          shipmentId,
          loadId: shipment.loadId,
          carrierId: user.id,
          carrierName: user.companyName || user.username,
        }, { title: "Trip Started", message: "Your shipment is now in transit." });

      } else if (otpType === "route_start") {
        // Route start - puts shipment in transit - run updates in parallel
        await Promise.all([
          storage.updateShipment(shipmentId, {
            routeStartOtpVerified: true,
            routeStartOtpVerifiedAt: new Date(),
            status: "in_transit",
          }),
          storage.updateLoad(shipment.loadId, { status: "in_transit" })
        ]);

        res.json({ 
          success: true, 
          message: "Route started successfully. GPS tracking activated.",
          shipmentStatus: "in_transit"
        });

        runBackgroundTasks("route_started", {
          shipmentId,
          loadId: shipment.loadId,
          carrierId: user.id,
          carrierName: user.companyName || user.username,
        }, { title: "Route Started", message: "Your shipment is now in transit. GPS tracking activated." });

      } else {
        // trip_end - run updates in parallel
        await Promise.all([
          storage.updateShipment(shipmentId, {
            endOtpVerified: true,
            endOtpVerifiedAt: new Date(),
            status: "delivered",
            completedAt: new Date(),
          }),
          storage.updateLoad(shipment.loadId, { status: "delivered" })
        ]);

        res.json({ 
          success: true, 
          message: "Trip completed successfully. Delivery confirmed.",
          shipmentStatus: "delivered"
        });

        runBackgroundTasks("trip_completed", {
          shipmentId,
          loadId: shipment.loadId,
          carrierId: user.id,
          carrierName: user.companyName || user.username,
        }, { title: "Delivery Completed", message: "Your shipment has been delivered successfully." });
      }
    } catch (error) {
      console.error("Verify OTP error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Get OTP status for a shipment (carrier view)
  app.get("/api/otp/status/:shipmentId", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { shipmentId } = req.params;
      const shipment = await storage.getShipment(shipmentId);
      if (!shipment) {
        return res.status(404).json({ error: "Shipment not found" });
      }

      // Check authorization
      if (user.role === "carrier" && shipment.carrierId !== user.id) {
        return res.status(403).json({ error: "Not authorized" });
      }

      const requests = await storage.getOtpRequestsByShipment(shipmentId);
      const now = new Date();
      
      // Check for approved requests with valid (non-expired) OTPs
      const startApprovedRequest = requests.find(r => 
        r.requestType === "trip_start" && r.status === "approved" && r.otpId
      );
      const routeStartApprovedRequest = requests.find(r => 
        r.requestType === "route_start" && r.status === "approved" && r.otpId
      );
      const endApprovedRequest = requests.find(r => 
        r.requestType === "trip_end" && r.status === "approved" && r.otpId
      );

      // Check if the OTP associated with approved request is still valid
      let startOtpApproved = false;
      let routeStartOtpApproved = false;
      let endOtpApproved = false;

      if (startApprovedRequest?.otpId && !shipment.startOtpVerified) {
        const otp = await storage.getOtpVerification(startApprovedRequest.otpId);
        // OTP is valid if it exists, hasn't been used (verified/expired), and hasn't expired
        // Accept both "pending" and "approved" status as valid for entry
        const isValidStatus = otp ? (otp.status === "pending" || otp.status === "approved") : false;
        startOtpApproved = isValidStatus && new Date(otp!.expiresAt) > now;
      }

      if (routeStartApprovedRequest?.otpId && !(shipment as any).routeStartOtpVerified) {
        const otp = await storage.getOtpVerification(routeStartApprovedRequest.otpId);
        const isValidStatus = otp ? (otp.status === "pending" || otp.status === "approved") : false;
        routeStartOtpApproved = isValidStatus && new Date(otp!.expiresAt) > now;
      }

      if (endApprovedRequest?.otpId && !shipment.endOtpVerified) {
        const otp = await storage.getOtpVerification(endApprovedRequest.otpId);
        const isValidStatus = otp ? (otp.status === "pending" || otp.status === "approved") : false;
        endOtpApproved = isValidStatus && new Date(otp!.expiresAt) > now;
      }

      res.json({
        shipmentId,
        startOtpRequested: shipment.startOtpRequested,
        startOtpVerified: shipment.startOtpVerified,
        routeStartOtpRequested: (shipment as any).routeStartOtpRequested,
        routeStartOtpVerified: (shipment as any).routeStartOtpVerified,
        endOtpRequested: shipment.endOtpRequested,
        endOtpVerified: shipment.endOtpVerified,
        // Approved means there's an approved request with a valid (non-expired) OTP
        startOtpApproved,
        routeStartOtpApproved,
        endOtpApproved,
        requests: requests.map(r => ({
          id: r.id,
          type: r.requestType,
          status: r.status,
          requestedAt: r.requestedAt,
          processedAt: r.processedAt,
        })),
      });
    } catch (error) {
      console.error("Get OTP status error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Registration OTP - For carrier signup (simulated)
  app.post("/api/otp/registration/send", async (req, res) => {
    try {
      const { phone, userId } = req.body;
      const rawPhone = typeof phone === "string" ? phone.trim() : "";
      if (!rawPhone) {
        return res.status(400).json({ error: "Phone number is required" });
      }

      const cleanedPhone = rawPhone.replace(/[\s-]/g, "");
      const phoneRegex = /^(\+91[\s-]?)?[6-9]\d{9}$/;
      if (!phoneRegex.test(cleanedPhone)) {
        return res.status(400).json({ error: "Invalid phone number format" });
      }

      const normalizedPhone = normalizePhoneForTwilio(cleanedPhone);
      const recentCount = await getRecentOtpRequestCount(normalizedPhone, "registration");
      if (recentCount >= 3) {
        return res.status(429).json({ error: "Too many OTP requests. Please try again in 15 minutes." });
      }

      const useTwilio = canUseTwilioVerify();
      const otpCode = useTwilio ? "twilio" : String(Math.floor(100000 + Math.random() * 900000));
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      const otpData: any = {
        otpType: "registration",
        otpCode,
        phoneNumber: normalizedPhone,
        validityMinutes: 10,
        expiresAt,
        status: "pending",
        attempts: 0,
        maxAttempts: 3,
      };

      if (userId && typeof userId === 'string' && userId.trim() !== '') {
        otpData.userId = userId;
      }

      const otp = await storage.createOtpVerification(otpData);

      if (useTwilio) {
        try {
          await sendTwilioOtp(normalizedPhone);
        } catch (error) {
          console.error("Registration OTP delivery failed:", {
            phone: maskPhone(normalizedPhone),
            error: error instanceof Error ? error.message : String(error),
          });
          return res.status(502).json({ error: "Failed to send OTP. Please try again." });
        }
      }

      console.info("Registration OTP requested", {
        phone: maskPhone(normalizedPhone),
        via: useTwilio ? "twilio" : "local",
      });

      res.json({ 
        success: true, 
        message: "OTP generated for verification",
        otpId: otp.id,
        ...(useTwilio ? {} : { otpCode }),
      });
    } catch (error: any) {
      console.error("Send registration OTP error:", error);
      const errorMessage = error?.message || "Database error creating OTP";
      res.status(500).json({ error: errorMessage });
    }
  });

  // Verify registration OTP
  app.post("/api/otp/registration/verify", async (req, res) => {
    try {
      const { otpId, otpCode } = req.body;
      if (!otpId || !otpCode) {
        return res.status(400).json({ error: "OTP ID and code are required" });
      }

      const cleanOtpCode = String(otpCode).trim();
      const otpRecord = await storage.getOtpVerification(otpId);
      if (!otpRecord) {
        return res.status(400).json({ error: "OTP verification not found" });
      }

      if (canUseTwilioVerify() && otpRecord.phoneNumber) {
        if (otpRecord.status !== "pending") {
          return res.status(400).json({ error: "OTP already used or expired" });
        }
        if (new Date() > new Date(otpRecord.expiresAt)) {
          await storage.updateOtpVerification(otpId, { status: "expired" });
          return res.status(400).json({ error: "OTP has expired" });
        }
        if (otpRecord.maxAttempts && (otpRecord.attempts || 0) >= otpRecord.maxAttempts) {
          return res.status(400).json({ error: "Maximum attempts exceeded" });
        }
        const approved = await checkTwilioOtp(otpRecord.phoneNumber, cleanOtpCode);
        if (!approved) {
          await storage.updateOtpVerification(otpId, { attempts: (otpRecord.attempts || 0) + 1 });
          return res.status(400).json({ error: "Invalid OTP code" });
        }
        const updated = await storage.updateOtpVerification(otpId, { status: "verified", verifiedAt: new Date() });
        if (updated?.userId) {
          await storage.updateUser(updated.userId, { isVerified: true });
        }
        console.info("Registration OTP verified", {
          otpId,
          phone: maskPhone(otpRecord.phoneNumber),
          via: "twilio",
        });
      } else {
        const result = await storage.verifyOtp(otpId, cleanOtpCode);
        if (!result.success) {
          return res.status(400).json({ error: result.message });
        }
        if (result.otp?.userId) {
          await storage.updateUser(result.otp.userId, { isVerified: true });
        }
        console.info("Registration OTP verified", {
          otpId,
          phone: maskPhone(otpRecord.phoneNumber || ""),
          via: "local",
        });
      }

      res.json({ 
        success: true, 
        message: "Phone number verified successfully" 
      });
    } catch (error) {
      console.error("Verify registration OTP error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Email OTP - For registration via email
  app.post("/api/otp/registration/send-email", async (req, res) => {
    try {
      const { email, userId } = req.body;
      if (!email) {
        return res.status(400).json({ error: "Email address is required" });
      }

      // Basic email validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: "Invalid email address format" });
      }

      // Generate OTP
      const otpCode = String(Math.floor(100000 + Math.random() * 900000));
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

      const otpData: any = {
        otpType: "email_registration",
        otpCode,
        phoneNumber: email, // Store email in phoneNumber field (repurposed for contact)
        validityMinutes: 10,
        expiresAt,
        status: "pending",
      };

      if (userId && typeof userId === 'string' && userId.trim() !== '') {
        otpData.userId = userId;
      }

      const otp = await storage.createOtpVerification(otpData);

      // Since no email service is configured, return OTP in response for in-app display
      // In production, you would send an email here and not return the code
      res.json({ 
        success: true, 
        message: "Verification code generated",
        otpId: otp.id,
        otpCode: otpCode, // Displayed in-app since no email service is configured
      });
    } catch (error: any) {
      console.error("Send email registration OTP error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Verify email registration OTP
  app.post("/api/otp/registration/verify-email", async (req, res) => {
    try {
      const { otpId, otpCode } = req.body;
      if (!otpId || !otpCode) {
        return res.status(400).json({ error: "OTP ID and code are required" });
      }

      const result = await storage.verifyOtp(otpId, otpCode);
      if (!result.success) {
        return res.status(400).json({ error: result.message });
      }

      // If OTP was linked to a user, mark them as verified
      if (result.otp?.userId) {
        await storage.updateUser(result.otp.userId, { isVerified: true });
      }

      res.json({ 
        success: true, 
        message: "Email verified successfully" 
      });
    } catch (error) {
      console.error("Verify email registration OTP error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // =============================================
  // OTP LOGIN - Login using phone OTP (no password required)
  // =============================================

  // Send OTP for login
  app.post("/api/auth/login-otp/send", async (req, res) => {
    try {
      const { phone } = req.body;
      const rawPhone = typeof phone === "string" ? phone.trim() : "";
      if (!rawPhone) {
        return res.status(400).json({ error: "Phone number is required" });
      }

      // Validate phone format
      const phoneRegex = /^(\+91[\s-]?)?[6-9]\d{9}$/;
      const cleanedPhone = rawPhone.replace(/[\s-]/g, "");
      if (!phoneRegex.test(cleanedPhone)) {
        return res.status(400).json({ error: "Invalid Indian phone number format" });
      }

      // Normalize phone number - try multiple formats for lookup
      // Users might have stored their phone as +91XXXXXXXXXX or XXXXXXXXXX
      const normalizedPhone = cleanedPhone.startsWith("+91") ? cleanedPhone : `+91 ${cleanedPhone}`;
      const phoneWithoutCode = cleanedPhone.replace(/^\+91/, "");
      
      // Try finding user with different phone formats
      let user = await storage.getUserByPhone(phone);
      if (!user) {
        user = await storage.getUserByPhone(normalizedPhone);
      }
      if (!user) {
        user = await storage.getUserByPhone(phoneWithoutCode);
      }
      if (!user) {
        user = await storage.getUserByPhone(`+91${phoneWithoutCode}`);
      }
      
      if (!user) {
        return res.status(404).json({ error: "No account found with this phone number. Please register first." });
      }

      const normalizedForRateLimit = normalizePhoneForTwilio(cleanedPhone);
      const recentCount = await getRecentOtpRequestCount(normalizedForRateLimit, "login");
      if (recentCount >= 3) {
        return res.status(429).json({ error: "Too many OTP requests. Please try again in 15 minutes." });
      }

      const useTwilio = canUseTwilioVerify();
      const otpCode = useTwilio ? "twilio" : String(Math.floor(100000 + Math.random() * 900000));
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      const otp = await storage.createOtpVerification({
        otpType: "login",
        otpCode,
        userId: user.id,
        phoneNumber: normalizedForRateLimit,
        validityMinutes: 10,
        expiresAt,
        status: "pending",
        attempts: 0,
        maxAttempts: 3,
      });

      if (useTwilio) {
        try {
          await sendTwilioOtp(normalizedForRateLimit);
        } catch (error) {
          console.error("Login OTP delivery failed:", {
            phone: maskPhone(normalizedForRateLimit),
            error: error instanceof Error ? error.message : String(error),
          });
          return res.status(502).json({ error: "Failed to send OTP. Please try again." });
        }
      }

      console.info("Login OTP requested", {
        phone: maskPhone(normalizedForRateLimit),
        userId: user.id,
        via: useTwilio ? "twilio" : "local",
      });

      res.json({ 
        success: true, 
        message: "OTP sent to your phone",
        otpId: otp.id,
        ...(useTwilio ? {} : { otpCode })
      });
    } catch (error: any) {
      console.error("Send login OTP error:", error);
      res.status(500).json({ error: "Failed to send OTP" });
    }
  });

  // Verify OTP and login
  app.post("/api/auth/login-otp/verify", async (req, res) => {
    try {
      const { otpId, otpCode } = req.body;
      if (!otpId || !otpCode) {
        return res.status(400).json({ error: "OTP ID and code are required" });
      }

      const cleanOtpCode = String(otpCode).trim();
      let verifiedOtp = undefined as Awaited<ReturnType<typeof storage.getOtpVerification>> | undefined;
      const otpRecord = await storage.getOtpVerification(otpId);
      if (!otpRecord) {
        return res.status(400).json({ error: "OTP not found" });
      }
      if (otpRecord.status !== "pending") {
        return res.status(400).json({ error: "OTP already used or expired" });
      }
      if (new Date() > new Date(otpRecord.expiresAt)) {
        await storage.updateOtpVerification(otpId, { status: "expired" });
        return res.status(400).json({ error: "OTP has expired" });
      }
      if (otpRecord.maxAttempts && (otpRecord.attempts || 0) >= otpRecord.maxAttempts) {
        return res.status(400).json({ error: "Maximum attempts exceeded" });
      }
      if (canUseTwilioVerify() && otpRecord.phoneNumber) {
        const approved = await checkTwilioOtp(otpRecord.phoneNumber, cleanOtpCode);
        if (!approved) {
          await storage.updateOtpVerification(otpId, { attempts: (otpRecord.attempts || 0) + 1 });
          console.warn("Login OTP verification failed", {
            otpId,
            phone: maskPhone(otpRecord.phoneNumber),
          });
          return res.status(400).json({ error: "Invalid OTP code" });
        }
        verifiedOtp = await storage.updateOtpVerification(otpId, { status: "verified", verifiedAt: new Date() });
      } else {
        const result = await storage.verifyOtp(otpId, cleanOtpCode);
        if (!result.success) {
          return res.status(400).json({ error: result.message });
        }
        verifiedOtp = result.otp;
      }

      // Validate OTP type is specifically for login (security: prevent cross-purpose OTP reuse)
      if (verifiedOtp?.otpType !== "login") {
        return res.status(400).json({ error: "Invalid OTP type - this code cannot be used for login" });
      }

      // Get the user from OTP
      if (!verifiedOtp?.userId) {
        return res.status(400).json({ error: "Invalid OTP - no user associated" });
      }

      const user = await storage.getUser(verifiedOtp.userId);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      req.session.userId = user.id;
      req.session.role = user.role;
      
      await storage.updateUser(user.id, { lastActiveAt: new Date() } as any);
      
      await new Promise<void>((resolve, reject) => {
        req.session.save((err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });

      const { password: _, ...userWithoutPassword } = user;
      console.info("Login OTP verified", {
        otpId,
        userId: user.id,
        phone: maskPhone(otpRecord.phoneNumber || ""),
        via: canUseTwilioVerify() ? "twilio" : "local",
      });
      res.json({ 
        success: true, 
        message: "Login successful",
        user: userWithoutPassword,
      });
    } catch (error) {
      console.error("Verify login OTP error:", error);
      res.status(500).json({ error: "Failed to verify OTP" });
    }
  });

  // =============================================
  // SHIPPER RATINGS - Carriers rate shippers after trip completion
  // =============================================

  // Submit a rating for a shipper
  app.post("/api/shipper-ratings", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Only carriers can rate shippers" });
      }

      const parsed = insertShipperRatingSchema.safeParse({
        ...req.body,
        carrierId: userId,
      });

      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid rating data", details: parsed.error.errors });
      }

      const { shipperId, shipmentId, loadId, rating, review } = parsed.data;

      // Verify the shipment exists and is delivered
      const shipment = await storage.getShipment(shipmentId);
      if (!shipment) {
        return res.status(404).json({ error: "Shipment not found" });
      }
      if (shipment.carrierId !== userId) {
        return res.status(403).json({ error: "You can only rate shippers for your own shipments" });
      }
      // Allow rating if shipment is delivered OR if trip end OTP was verified (which sets status to delivered)
      if (shipment.status !== "delivered" && !shipment.endOtpVerified) {
        return res.status(400).json({ error: "Can only rate after delivery is complete" });
      }

      // Check if already rated
      const existingRatings = await db.select().from(shipperRatings).where(eq(shipperRatings.shipmentId, shipmentId));
      if (existingRatings.length > 0) {
        return res.status(400).json({ error: "You have already rated this shipper for this shipment" });
      }

      // Insert the rating
      const [newRating] = await db.insert(shipperRatings).values({
        shipperId,
        carrierId: userId,
        shipmentId,
        loadId,
        rating,
        review: review || null,
      }).returning();

      res.status(201).json(newRating);
    } catch (error: any) {
      console.error("Submit shipper rating error:", error);
      res.status(500).json({ error: "Failed to submit rating" });
    }
  });

  // Get average rating for a shipper
  app.get("/api/shipper/:shipperId/rating", async (req, res) => {
    try {
      const { shipperId } = req.params;

      const ratings = await db.select().from(shipperRatings).where(eq(shipperRatings.shipperId, shipperId));
      
      if (ratings.length === 0) {
        return res.json({ 
          averageRating: null, 
          totalRatings: 0,
          ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
        });
      }

      const sum = ratings.reduce((acc, r) => acc + r.rating, 0);
      const average = sum / ratings.length;

      // Calculate rating distribution
      const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      ratings.forEach(r => {
        if (r.rating >= 1 && r.rating <= 5) {
          distribution[r.rating as 1|2|3|4|5]++;
        }
      });

      res.json({
        averageRating: Math.round(average * 10) / 10,
        totalRatings: ratings.length,
        ratingDistribution: distribution
      });
    } catch (error: any) {
      console.error("Get shipper rating error:", error);
      res.status(500).json({ error: "Failed to get rating" });
    }
  });

  // Get all ratings for a shipper (with details)
  app.get("/api/shipper/:shipperId/ratings", async (req, res) => {
    try {
      const { shipperId } = req.params;

      const ratings = await db.select().from(shipperRatings).where(eq(shipperRatings.shipperId, shipperId));
      
      // Get carrier names for the ratings
      const ratingsWithCarrierNames = await Promise.all(
        ratings.map(async (rating) => {
          const carrier = await storage.getUser(rating.carrierId);
          return {
            ...rating,
            carrierName: carrier?.companyName || carrier?.username || "Anonymous"
          };
        })
      );

      res.json(ratingsWithCarrierNames);
    } catch (error: any) {
      console.error("Get shipper ratings error:", error);
      res.status(500).json({ error: "Failed to get ratings" });
    }
  });

  // Check if carrier has already rated a shipment
  app.get("/api/shipper-ratings/check/:shipmentId", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const { shipmentId } = req.params;

      const existingRatings = await db.select().from(shipperRatings)
        .where(eq(shipperRatings.shipmentId, shipmentId));
      
      const hasRated = existingRatings.some(r => r.carrierId === userId);

      res.json({ hasRated });
    } catch (error: any) {
      console.error("Check rating error:", error);
      res.status(500).json({ error: "Failed to check rating status" });
    }
  });

  // =============================================
  // CARRIER RATINGS - Shippers rate carriers after delivery
  // =============================================

  // Submit a rating for a carrier
  app.post("/api/carrier-ratings", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      
      if (!user || user.role !== "shipper") {
        return res.status(403).json({ error: "Only shippers can rate carriers" });
      }

      const parsed = insertCarrierRatingSchema.safeParse({
        ...req.body,
        shipperId: userId,
      });

      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid rating data", details: parsed.error.errors });
      }

      const { carrierId, shipmentId, loadId, rating, review } = parsed.data;

      // Verify the shipment exists and is delivered
      const shipment = await storage.getShipment(shipmentId);
      if (!shipment) {
        return res.status(404).json({ error: "Shipment not found" });
      }
      
      // Verify this shipment belongs to the shipper's load
      const load = await storage.getLoad(loadId);
      if (!load || load.shipperId !== userId) {
        return res.status(403).json({ error: "You can only rate carriers for your own shipments" });
      }
      
      // Allow rating if shipment is delivered
      if (shipment.status !== "delivered") {
        return res.status(400).json({ error: "Can only rate after delivery is complete" });
      }

      // Check if already rated
      const existingRatings = await db.select().from(carrierRatings).where(eq(carrierRatings.shipmentId, shipmentId));
      if (existingRatings.some(r => r.shipperId === userId)) {
        return res.status(400).json({ error: "You have already rated this carrier for this shipment" });
      }

      // Insert the rating
      const [newRating] = await db.insert(carrierRatings).values({
        carrierId,
        shipperId: userId,
        shipmentId,
        loadId,
        rating,
        review: review || null,
      }).returning();

      // Calculate new average rating for the carrier
      const allRatings = await db.select().from(carrierRatings).where(eq(carrierRatings.carrierId, carrierId));
      const averageRating = allRatings.reduce((sum, r) => sum + r.rating, 0) / allRatings.length;
      const roundedAverage = Math.round(averageRating * 10) / 10;

      // Count ratings with 3.5+ stars for badge level calculation
      const qualifyingRatingsCount = allRatings.filter(r => r.rating >= 3.5).length;
      
      // Calculate badge level based on new standards:
      // - Bronze: Default (less than 250 ratings with 3.5+ stars)
      // - Silver: 250+ ratings with 3.5+ stars
      // - Gold: 550+ ratings with 3.5+ stars
      let newBadgeLevel = "bronze";
      if (qualifyingRatingsCount >= 550) {
        newBadgeLevel = "gold";
      } else if (qualifyingRatingsCount >= 250) {
        newBadgeLevel = "silver";
      }

      // Update carrier profile with new badge level
      const carrierProfile = await storage.getCarrierProfile(carrierId);
      if (carrierProfile && carrierProfile.badgeLevel !== newBadgeLevel) {
        await storage.updateCarrierProfile(carrierId, { badgeLevel: newBadgeLevel });
      }

      // Get shipper name for the notification
      const shipperName = user.companyName || user.username || "A shipper";

      // Broadcast real-time rating notification to the carrier
      broadcastRatingReceived(carrierId, {
        rating,
        review: review || undefined,
        shipperName,
        averageRating: roundedAverage,
        totalRatings: allRatings.length,
        badgeLevel: newBadgeLevel,
        qualifyingRatingsCount,
      });

      res.json(newRating);
    } catch (error: any) {
      console.error("Submit carrier rating error:", error);
      res.status(500).json({ error: "Failed to submit rating" });
    }
  });

  // Get average rating for a carrier
  app.get("/api/carrier/:carrierId/rating", async (req, res) => {
    try {
      const { carrierId } = req.params;

      const ratings = await db.select().from(carrierRatings).where(eq(carrierRatings.carrierId, carrierId));
      
      if (ratings.length === 0) {
        return res.json({ averageRating: null, totalRatings: 0 });
      }

      const averageRating = ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length;
      res.json({ 
        averageRating: Math.round(averageRating * 10) / 10, 
        totalRatings: ratings.length 
      });
    } catch (error: any) {
      console.error("Get carrier rating error:", error);
      res.status(500).json({ error: "Failed to get rating" });
    }
  });

  // Get all ratings for a carrier (with details)
  app.get("/api/carrier/:carrierId/ratings", async (req, res) => {
    try {
      const { carrierId } = req.params;

      const ratings = await db.select().from(carrierRatings).where(eq(carrierRatings.carrierId, carrierId));
      
      // Get shipper names for the ratings
      const ratingsWithShipperNames = await Promise.all(
        ratings.map(async (rating) => {
          const shipper = await storage.getUser(rating.shipperId);
          return {
            ...rating,
            shipperName: shipper?.companyName || shipper?.username || "Anonymous"
          };
        })
      );

      res.json(ratingsWithShipperNames);
    } catch (error: any) {
      console.error("Get carrier ratings error:", error);
      res.status(500).json({ error: "Failed to get ratings" });
    }
  });

  // Check if shipper has already rated a shipment's carrier
  app.get("/api/carrier-ratings/check/:shipmentId", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const { shipmentId } = req.params;

      const existingRatings = await db.select().from(carrierRatings)
        .where(eq(carrierRatings.shipmentId, shipmentId));
      
      const hasRated = existingRatings.some(r => r.shipperId === userId);

      res.json({ hasRated });
    } catch (error: any) {
      console.error("Check carrier rating error:", error);
      res.status(500).json({ error: "Failed to check rating status" });
    }
  });

  // =============================================
  // SAVED ADDRESSES - Admin endpoints for managing shipper addresses
  // =============================================

  app.get("/api/admin/saved-addresses/:shipperId/:type", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Only admins can access saved addresses" });
      }

      const { shipperId, type } = req.params;

      if (type !== "pickup" && type !== "dropoff") {
        return res.status(400).json({ error: "Invalid address type. Must be 'pickup' or 'dropoff'" });
      }

      const shipperUser = await storage.getUser(shipperId);
      if (!shipperUser) {
        return res.json([]);
      }
      const shipperNumericId = shipperUser.userNumber || parseInt(shipperId) || 0;

      const addresses = await db.select().from(savedAddresses)
        .where(eq(savedAddresses.shipperId, shipperNumericId));
      
      const filteredAddresses = addresses
        .filter(a => a.addressType === type && a.isActive)
        .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0));

      res.json(filteredAddresses);
    } catch (error: any) {
      console.error("Admin get saved addresses error:", error);
      res.status(500).json({ error: "Failed to get saved addresses" });
    }
  });

  app.post("/api/admin/saved-addresses", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Only admins can save addresses" });
      }

      const shipperUser = await storage.getUser(req.body.shipperId);
      const shipperNumericId = shipperUser?.userNumber || parseInt(req.body.shipperId) || 0;

      const parsed = insertSavedAddressSchema.safeParse({
        ...req.body,
        shipperId: shipperNumericId,
      });

      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid address data", details: parsed.error.errors });
      }

      const [newAddress] = await db.insert(savedAddresses).values(parsed.data).returning();

      res.json(newAddress);
    } catch (error: any) {
      console.error("Admin save address error:", error);
      res.status(500).json({ error: "Failed to save address" });
    }
  });

  // =============================================
  // SAVED ADDRESSES - Shipper address book
  // =============================================

  // Get all saved addresses for the current shipper
  app.get("/api/shipper/saved-addresses", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      
      if (!user || user.role !== "shipper") {
        return res.status(403).json({ error: "Only shippers can access saved addresses" });
      }

      const shipperNumericId = user.userNumber || parseInt(userId) || 0;

      const addresses = await db.select().from(savedAddresses)
        .where(eq(savedAddresses.shipperId, shipperNumericId))
        .orderBy(savedAddresses.usageCount);
      
      // Sort by usage count descending (most used first)
      addresses.sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0));

      res.json(addresses);
    } catch (error: any) {
      console.error("Get saved addresses error:", error);
      res.status(500).json({ error: "Failed to get saved addresses" });
    }
  });

  // Get saved addresses by type (pickup or dropoff)
  app.get("/api/shipper/saved-addresses/:type", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      const { type } = req.params;
      
      if (!user || user.role !== "shipper") {
        return res.status(403).json({ error: "Only shippers can access saved addresses" });
      }

      if (type !== "pickup" && type !== "dropoff") {
        return res.status(400).json({ error: "Invalid address type. Must be 'pickup' or 'dropoff'" });
      }

      const shipperNumericId = user.userNumber || parseInt(userId) || 0;

      const addresses = await db.select().from(savedAddresses)
        .where(eq(savedAddresses.shipperId, shipperNumericId));
      
      // Filter by type and sort by usage count descending
      const filteredAddresses = addresses
        .filter(a => a.addressType === type && a.isActive)
        .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0));

      res.json(filteredAddresses);
    } catch (error: any) {
      console.error("Get saved addresses by type error:", error);
      res.status(500).json({ error: "Failed to get saved addresses" });
    }
  });

  // Save a new address
  app.post("/api/shipper/saved-addresses", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      
      if (!user || user.role !== "shipper") {
        return res.status(403).json({ error: "Only shippers can save addresses" });
      }

      const shipperNumericId = user.userNumber || parseInt(userId) || 0;

      const parsed = insertSavedAddressSchema.safeParse({
        ...req.body,
        shipperId: shipperNumericId,
      });

      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid address data", details: parsed.error.errors });
      }

      const [newAddress] = await db.insert(savedAddresses).values(parsed.data).returning();

      res.json(newAddress);
    } catch (error: any) {
      console.error("Save address error:", error);
      res.status(500).json({ error: "Failed to save address" });
    }
  });

  // Update usage count when address is used
  app.post("/api/shipper/saved-addresses/:id/use", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      const addressId = parseInt(req.params.id);
      
      if (!user || user.role !== "shipper") {
        return res.status(403).json({ error: "Only shippers can use saved addresses" });
      }

      // Verify ownership
      const shipperNumericId = user.userNumber || parseInt(userId) || 0;
      const [address] = await db.select().from(savedAddresses).where(eq(savedAddresses.id, addressId));
      if (!address || address.shipperId !== shipperNumericId) {
        return res.status(404).json({ error: "Address not found" });
      }

      // Increment usage count
      const [updated] = await db.update(savedAddresses)
        .set({ 
          usageCount: (address.usageCount || 0) + 1,
          updatedAt: new Date()
        })
        .where(eq(savedAddresses.id, addressId))
        .returning();

      res.json(updated);
    } catch (error: any) {
      console.error("Update address usage error:", error);
      res.status(500).json({ error: "Failed to update address usage" });
    }
  });

  // Delete a saved address
  app.delete("/api/shipper/saved-addresses/:id", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId!;
      const user = await storage.getUser(userId);
      const addressId = parseInt(req.params.id);
      
      if (!user || user.role !== "shipper") {
        return res.status(403).json({ error: "Only shippers can delete saved addresses" });
      }

      // Verify ownership
      const shipperNumericId = user.userNumber || parseInt(userId) || 0;
      const [address] = await db.select().from(savedAddresses).where(eq(savedAddresses.id, addressId));
      if (!address || address.shipperId !== shipperNumericId) {
        return res.status(404).json({ error: "Address not found" });
      }

      // Soft delete by setting isActive to false
      await db.update(savedAddresses)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(savedAddresses.id, addressId));

      res.json({ success: true });
    } catch (error: any) {
      console.error("Delete address error:", error);
      res.status(500).json({ error: "Failed to delete address" });
    }
  });

  // ============ Contact Form Submission ============

  // Handle contact form submissions (public endpoint - no auth required)
  app.post("/api/contact", async (req, res) => {
    try {
      const { contactSubmissions, insertContactSubmissionSchema } = await import("@shared/schema");
      const nodemailer = await import("nodemailer");

      const parsed = insertContactSubmissionSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid form data", details: parsed.error.errors });
      }

      const { fullName, email, phone, subject, message } = parsed.data;

      // Store in database
      const [submission] = await db.insert(contactSubmissions).values({
        fullName,
        email,
        phone: phone || null,
        subject: subject || null,
        message,
      }).returning();

      // Send email notification
      try {
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST || "smtp.gmail.com",
          port: parseInt(process.env.SMTP_PORT || "587"),
          secure: process.env.SMTP_SECURE === "true",
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
          },
        });

        const mailOptions = {
          from: process.env.SMTP_FROM || "noreply@loadsmart.in",
          to: "info@loadsmart.in",
          subject: `New Contact Form Submission: ${subject || "General Inquiry"}`,
          html: `
            <h2>New Contact Form Submission</h2>
            <p><strong>From:</strong> ${fullName}</p>
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>Phone:</strong> ${phone || "Not provided"}</p>
            <p><strong>Subject:</strong> ${subject || "Not specified"}</p>
            <hr />
            <h3>Message:</h3>
            <p>${message.replace(/\n/g, "<br>")}</p>
            <hr />
            <p><em>Submitted at: ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</em></p>
          `,
          replyTo: email,
        };

        // Only attempt to send if SMTP credentials are configured
        if (process.env.SMTP_USER && process.env.SMTP_PASS) {
          await transporter.sendMail(mailOptions);
          console.log("Contact form email sent successfully");
        } else {
          console.log("SMTP not configured - email notification skipped but submission saved");
        }
      } catch (emailError) {
        console.error("Failed to send email notification:", emailError);
        // Don't fail the request - submission is already saved
      }

      res.json({ 
        success: true, 
        message: "Thank you for your message. We'll get back to you soon!",
        submissionId: submission.id 
      });
    } catch (error: any) {
      console.error("Contact form error:", error);
      res.status(500).json({ error: "Failed to submit contact form" });
    }
  });

  // ============ Recommended Carriers for Load ============
  
  // Get recommended carriers for a specific load based on matching criteria
  app.get("/api/loads/:id/recommended-carriers", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const load = await storage.getLoad(req.params.id);
      if (!load) {
        return res.status(404).json({ error: "Load not found" });
      }

      // Get all verified carriers with their profiles and trucks
      const allUsers = await storage.getAllUsers();
      const verifiedCarriers = allUsers.filter(u => u.role === "carrier" && u.isVerified);

      // Get all shipments and loads for historical analysis
      const allShipments = await db.select().from(shipmentsTable);
      const allLoads = await db.select().from(loadsTable);
      const allTrucks = await db.select().from(trucksTable);

      const recommendations: Array<{
        carrierId: string;
        carrierName: string;
        carrierCompany: string | null;
        carrierPhone: string | null;
        carrierEmail: string | null;
        carrierType: string;
        score: number;
        matchReasons: string[];
        truckTypeMatch: boolean;
        capacityMatch: boolean;
        routeExperience: boolean;
        commodityExperience: boolean;
        shipperExperience: boolean;
        trucks: Array<{
          id: string;
          truckType: string | null;
          registrationNumber: string | null;
          capacity: string | null;
          manufacturer: string | null;
          model: string | null;
        }>;
        fleetSize: number | null;
        completedTrips: number;
        serviceZones: string[];
        operatingRegion: string | null;
      }> = [];

      for (const carrier of verifiedCarriers) {
        let score = 0;
        const matchReasons: string[] = [];
        let truckTypeMatch = false;
        let capacityMatch = false;
        let routeExperience = false;
        let commodityExperience = false;
        let shipperExperience = false;

        // Get carrier profile
        const carrierProfile = await storage.getCarrierProfile(carrier.id);
        const carrierType = carrierProfile?.carrierType || "enterprise";

        // Get carrier's trucks
        const carrierTrucks = allTrucks.filter(t => t.carrierId === carrier.id);

        // 1. Truck type match (30 points)
        if (load.requiredTruckType && carrierTrucks.some(t => t.truckType === load.requiredTruckType)) {
          score += 30;
          truckTypeMatch = true;
          matchReasons.push(`Has matching truck type: ${load.requiredTruckType}`);
        }

        // 2. Capacity match (25 points) - check if any truck can carry the load weight
        const loadWeight = parseFloat(load.weight?.toString() || "0");
        if (carrierTrucks.some(t => {
          const capacity = parseFloat(t.capacity?.toString() || "0");
          return capacity >= loadWeight;
        })) {
          score += 25;
          capacityMatch = true;
          matchReasons.push(`Can carry ${loadWeight} MT`);
        }

        // 3. Route experience (20 points) - has done similar routes before
        const carrierShipments = allShipments.filter(s => s.carrierId === carrier.id);
        const carrierCompletedLoads = carrierShipments.map(s => 
          allLoads.find(l => l.id === s.loadId)
        ).filter(Boolean);
        
        const hasRouteExperience = carrierCompletedLoads.some(l => 
          l && (
            (l.pickupCity === load.pickupCity && l.dropoffCity === load.dropoffCity) ||
            (l.pickupState === load.pickupState && l.dropoffState === load.dropoffState)
          )
        );
        if (hasRouteExperience) {
          score += 20;
          routeExperience = true;
          matchReasons.push(`Has experience on ${load.pickupCity} to ${load.dropoffCity} route`);
        }

        // 4. Commodity experience (15 points) - has carried similar materials before
        const hasCommodityExperience = carrierCompletedLoads.some(l => 
          l && l.materialType && load.materialType && 
          l.materialType.toLowerCase().includes(load.materialType.toLowerCase().split(" ")[0])
        );
        if (hasCommodityExperience) {
          score += 15;
          commodityExperience = true;
          matchReasons.push(`Has carried similar commodity: ${load.materialType}`);
        }

        // 5. Shipper experience (10 points) - has worked with this shipper before
        const hasShipperExperience = carrierShipments.some(s => s.shipperId === load.shipperId);
        if (hasShipperExperience) {
          score += 10;
          shipperExperience = true;
          matchReasons.push("Has worked with this shipper before");
        }

        // Only include carriers with at least some match
        if (score > 0) {
          // Count completed trips for this carrier
          const completedTrips = carrierShipments.filter(s => 
            s.status === "delivered" || s.status === "closed" || s.status === "completed"
          ).length;

          recommendations.push({
            carrierId: carrier.id,
            carrierName: carrier.username,
            carrierCompany: carrierProfile?.companyName || carrier.companyName,
            carrierPhone: carrier.phone,
            carrierEmail: carrier.email,
            carrierType,
            score,
            matchReasons,
            truckTypeMatch,
            capacityMatch,
            routeExperience,
            commodityExperience,
            shipperExperience,
            trucks: carrierTrucks.map(t => ({
              id: t.id,
              truckType: t.truckType,
              registrationNumber: t.registrationNumber,
              capacity: t.capacity?.toString() || null,
              manufacturer: t.make,
              model: t.model,
            })),
            fleetSize: carrierProfile?.fleetSize || null,
            completedTrips,
            serviceZones: carrierProfile?.serviceZones || [],
            operatingRegion: carrierProfile?.operatingRegion || null,
          });
        }
      }

      // Sort by score descending
      recommendations.sort((a, b) => b.score - a.score);

      // Return top 10 recommendations
      res.json(recommendations.slice(0, 10));
    } catch (error: any) {
      console.error("Get recommended carriers error:", error);
      res.status(500).json({ error: "Failed to get recommended carriers" });
    }
  });

  // ============ Recommended Loads for Carrier ============
  
  // Get recommended loads for a carrier based on their profile and history
  app.get("/api/carrier/recommended-loads", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "carrier") {
        return res.status(403).json({ error: "Carrier access required" });
      }

      // Get carrier's trucks and profile
      const carrierProfile = await storage.getCarrierProfile(user.id);
      const carrierTrucks = await db.select().from(trucksTable).where(eq(trucksTable.carrierId, user.id));

      // Get available loads (posted to carriers, open for bid)
      const availableLoads = await db.select().from(loadsTable).where(
        or(
          eq(loadsTable.status, "posted_to_carriers"),
          eq(loadsTable.status, "open_for_bid"),
          eq(loadsTable.status, "counter_received")
        )
      );

      // Get carrier's shipment history for route/commodity matching
      const carrierShipments = await db.select().from(shipmentsTable).where(eq(shipmentsTable.carrierId, user.id));
      const allLoads = await db.select().from(loadsTable);
      const completedLoadIds = carrierShipments.map(s => s.loadId);
      const historicalLoads = allLoads.filter(l => completedLoadIds.includes(l.id));

      // Collect carrier's route and commodity experience
      const routesExperienced = new Set<string>();
      const commoditiesExperienced = new Set<string>();
      const shippersWorkedWith = new Set<string>();

      for (const l of historicalLoads) {
        if (l.pickupCity && l.dropoffCity) {
          routesExperienced.add(`${l.pickupCity}-${l.dropoffCity}`);
          routesExperienced.add(`${l.pickupState}-${l.dropoffState}`);
        }
        if (l.materialType) {
          commoditiesExperienced.add(l.materialType.toLowerCase().split(" ")[0]);
        }
      }
      for (const s of carrierShipments) {
        if (s.shipperId) shippersWorkedWith.add(s.shipperId);
      }

      // Score each available load
      const recommendations: Array<{
        loadId: string;
        loadNumber: string;
        pickupCity: string;
        dropoffCity: string;
        weight: string;
        materialType: string | null;
        requiredTruckType: string | null;
        pickupDate: Date | null;
        price: number | null;
        score: number;
        matchReasons: string[];
        truckTypeMatch: boolean;
        capacityMatch: boolean;
        routeMatch: boolean;
        commodityMatch: boolean;
        shipperMatch: boolean;
      }> = [];

      for (const load of availableLoads) {
        let score = 0;
        const matchReasons: string[] = [];
        let truckTypeMatch = false;
        let capacityMatch = false;
        let routeMatch = false;
        let commodityMatch = false;
        let shipperMatch = false;

        // 1. Truck type match (30 points)
        if (load.requiredTruckType && carrierTrucks.some(t => t.truckType === load.requiredTruckType)) {
          score += 30;
          truckTypeMatch = true;
          matchReasons.push(`Your truck matches: ${load.requiredTruckType}`);
        }

        // 2. Capacity match (25 points)
        const loadWeight = parseFloat(load.weight?.toString() || "0");
        if (carrierTrucks.some(t => {
          const capacity = parseFloat(t.capacity?.toString() || "0");
          return capacity >= loadWeight;
        })) {
          score += 25;
          capacityMatch = true;
          matchReasons.push(`Your truck can carry ${loadWeight} MT`);
        }

        // 3. Route experience (20 points)
        const routeKey = `${load.pickupCity}-${load.dropoffCity}`;
        const stateRouteKey = `${load.pickupState}-${load.dropoffState}`;
        if (routesExperienced.has(routeKey) || routesExperienced.has(stateRouteKey)) {
          score += 20;
          routeMatch = true;
          matchReasons.push(`You've done ${load.pickupCity} to ${load.dropoffCity} route before`);
        }

        // 4. Commodity experience (15 points)
        if (load.materialType && commoditiesExperienced.has(load.materialType.toLowerCase().split(" ")[0])) {
          score += 15;
          commodityMatch = true;
          matchReasons.push(`You've carried ${load.materialType} before`);
        }

        // 5. Shipper familiarity (10 points)
        if (shippersWorkedWith.has(load.shipperId)) {
          score += 10;
          shipperMatch = true;
          matchReasons.push("You've worked with this shipper before");
        }

        recommendations.push({
          loadId: load.id,
          loadNumber: `LD-${String(load.shipperLoadNumber || 0).padStart(3, '0')}`,
          pickupCity: load.pickupCity,
          dropoffCity: load.dropoffCity,
          weight: load.weight?.toString() || "0",
          materialType: load.materialType,
          requiredTruckType: load.requiredTruckType,
          pickupDate: load.pickupDate,
          price: load.adminFinalPrice ? parseFloat(load.adminFinalPrice.toString()) : null,
          score,
          matchReasons,
          truckTypeMatch,
          capacityMatch,
          routeMatch,
          commodityMatch,
          shipperMatch,
        });
      }

      // Sort by score descending, then by pickup date
      recommendations.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.pickupDate && b.pickupDate) {
          return new Date(a.pickupDate).getTime() - new Date(b.pickupDate).getTime();
        }
        return 0;
      });

      // Return recommendations (all loads, sorted by match score)
      res.json(recommendations);
    } catch (error: any) {
      console.error("Get recommended loads error:", error);
      res.status(500).json({ error: "Failed to get recommended loads" });
    }
  });

  // ==================== FINANCE ROUTES ====================

  // GET /api/finance/shipments - Get all shipments with docs for finance review
  app.get("/api/finance/shipments", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const allShipments = await storage.getAllShipments();

      const enrichedShipments = await Promise.all(
        allShipments.map(async (shipment) => {
          const load = await storage.getLoad(shipment.loadId);
          const carrier = await storage.getUser(shipment.carrierId);
          const carrierProfile = carrier ? await storage.getCarrierProfile(carrier.id) : null;
          const shipper = load ? await storage.getUser(load.shipperId) : null;
          const documents = await storage.getDocumentsByShipment(shipment.id);
          const financeReview = await storage.getFinanceReviewByShipment(shipment.id);
          const reviewer = financeReview?.reviewerId ? await storage.getUser(financeReview.reviewerId) : null;

          return {
            id: shipment.id,
            loadId: shipment.loadId,
            status: shipment.status,
            createdAt: shipment.createdAt,
            startedAt: shipment.startedAt,
            completedAt: shipment.completedAt,
            load: load ? {
              id: load.id,
              referenceNumber: load.shipperLoadNumber || load.adminReferenceNumber,
              pickupCity: load.pickupCity,
              pickupAddress: load.pickupAddress,
              pickupState: load.pickupState,
              pickupLocality: load.pickupLocality,
              pickupLandmark: load.pickupLandmark,
              dropoffCity: load.dropoffCity,
              dropoffAddress: load.dropoffAddress,
              dropoffState: load.dropoffState,
              dropoffLocality: load.dropoffLocality,
              dropoffLandmark: load.dropoffLandmark,
              dropoffBusinessName: load.dropoffBusinessName,
              materialType: load.materialType,
              weight: load.weight,
              requiredTruckType: load.requiredTruckType,
              pickupDate: load.pickupDate,
              deliveryDate: load.deliveryDate,
              adminFinalPrice: load.adminFinalPrice,
            } : null,
            shipper: shipper ? {
              id: shipper.id,
              username: shipper.username,
              companyName: load?.shipperCompanyName || shipper.companyName || shipper.username,
              phone: shipper.phone,
            } : null,
            carrier: carrier ? {
              id: carrier.id,
              username: carrier.username,
              companyName: carrierProfile?.companyName || carrier.companyName || carrier.username,
              phone: carrier.phone,
              carrierType: carrierProfile?.carrierType || "solo",
            } : null,
            documents: documents.map(doc => ({
              id: doc.id,
              documentType: doc.documentType,
              fileName: doc.fileName,
              fileUrl: doc.fileUrl,
              fileSize: doc.fileSize,
              isVerified: doc.isVerified,
              createdAt: doc.createdAt,
            })),
            financeReview: financeReview ? {
              id: financeReview.id,
              status: financeReview.status,
              comment: financeReview.comment,
              paymentStatus: financeReview.paymentStatus,
              reviewedAt: financeReview.reviewedAt,
              reviewerName: reviewer?.username || "Unknown",
            } : null,
          };
        })
      );

      res.json(enrichedShipments);
    } catch (error) {
      console.error("Get finance shipments error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/finance/reviews - Create or update a finance review for a shipment
  app.post("/api/finance/reviews", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const reviewSchema = z.object({
        shipmentId: z.string().min(1),
        loadId: z.string().min(1),
        status: z.enum(["pending", "approved", "on_hold", "rejected"]),
        comment: z.string().optional(),
        paymentStatus: z.enum(["not_released", "processing", "released"]).optional(),
      });

      const parsed = reviewSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid review data", details: parsed.error.issues });
      }

      const { shipmentId, loadId, status, comment, paymentStatus } = parsed.data;

      const existing = await storage.getFinanceReviewByShipment(shipmentId);

      if (existing) {
        const updated = await storage.updateFinanceReview(existing.id, {
          status,
          comment: comment || existing.comment,
          paymentStatus: paymentStatus || existing.paymentStatus,
          reviewerId: user.id,
          reviewedAt: new Date(),
        });
        return res.json(updated);
      }

      const review = await storage.createFinanceReview({
        shipmentId,
        loadId,
        reviewerId: user.id,
        status,
        comment: comment || null,
        paymentStatus: paymentStatus || "not_released",
        reviewedAt: new Date(),
      });

      res.json(review);
    } catch (error) {
      console.error("Create finance review error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // PATCH /api/finance/reviews/:id/payment - Update payment status
  app.patch("/api/finance/reviews/:id/payment", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const paymentSchema = z.object({
        paymentStatus: z.enum(["not_released", "processing", "released"]),
      });
      const parsed = paymentSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid payment status", details: parsed.error.issues });
      }
      const { paymentStatus } = parsed.data;

      const updated = await storage.updateFinanceReview(req.params.id, {
        paymentStatus,
      });

      if (!updated) {
        return res.status(404).json({ error: "Finance review not found" });
      }

      res.json(updated);
    } catch (error) {
      console.error("Update payment status error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/finance/reviews/all - Get all finance reviews (must be before :shipmentId route)
  app.get("/api/finance/reviews/all", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const allReviews = await storage.getAllFinanceReviews();
      res.json(allReviews);
    } catch (error) {
      console.error("Get all finance reviews error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/finance/reviews/:shipmentId - Get finance review for a specific shipment
  app.get("/api/finance/reviews/:shipmentId", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const review = await storage.getFinanceReviewByShipment(req.params.shipmentId);
      if (!review) {
        return res.json(null);
      }

      const reviewer = await storage.getUser(review.reviewerId);
      res.json({
        ...review,
        reviewerName: reviewer?.username || "Unknown",
      });
    } catch (error) {
      console.error("Get finance review error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Setup WebSocket for real-time telemetry
  setupTelemetryWebSocket(httpServer);

  return httpServer;
}
