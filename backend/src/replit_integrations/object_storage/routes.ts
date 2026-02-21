import type { Express, Request, Response, NextFunction } from "express";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";

// Authentication middleware - checks if user is logged in
function requireAuth(req: Request, res: Response, next: NextFunction) {
  console.log('[ObjectStorage] Auth check:', {
    path: req.path,
    hasSession: !!req.session,
    userId: req.session?.userId,
    cookies: Object.keys(req.cookies || {}),
    headers: {
      cookie: req.headers.cookie ? 'present' : 'missing',
      origin: req.headers.origin,
    }
  });
  
  if (!req.session?.userId) {
    console.log('[ObjectStorage] Authentication failed - no userId in session');
    return res.status(401).json({ error: "Authentication required" });
  }
  next();
}

// File size limit: 10MB
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Allowed content types for document uploads
const ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
];

/**
 * Register object storage routes for file uploads.
 *
 * Security: All routes require authentication via session.
 * File uploads are limited to 10MB and specific content types.
 */
export function registerObjectStorageRoutes(app: Express): void {
  const objectStorageService = new ObjectStorageService();

  /**
   * Request a presigned URL for file upload.
   * Requires authentication.
   *
   * Request body (JSON):
   * {
   *   "name": "filename.jpg",
   *   "size": 12345,
   *   "contentType": "image/jpeg"
   * }
   *
   * Response:
   * {
   *   "uploadURL": "https://storage.googleapis.com/...",
   *   "objectPath": "/objects/uploads/uuid"
   * }
   */
  app.post("/api/uploads/request-url", requireAuth, async (req, res) => {
    try {
      const { name, size, contentType } = req.body;

      if (!name) {
        return res.status(400).json({
          error: "Missing required field: name",
        });
      }

      // Validate file size
      if (size && size > MAX_FILE_SIZE) {
        return res.status(400).json({
          error: `File too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024)}MB`,
        });
      }

      // Validate content type
      if (contentType && !ALLOWED_CONTENT_TYPES.includes(contentType)) {
        return res.status(400).json({
          error: `Invalid file type. Allowed: ${ALLOWED_CONTENT_TYPES.join(", ")}`,
        });
      }

      const uploadURL = await objectStorageService.getObjectEntityUploadURL();

      // Extract object path from the presigned URL for later reference
      const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

      res.json({
        uploadURL,
        objectPath,
        // Echo back the metadata for client convenience
        metadata: { name, size, contentType },
      });
    } catch (error) {
      console.error("Error generating upload URL:", error);
      res.status(500).json({ error: "Failed to generate upload URL" });
    }
  });

  /**
   * Serve uploaded objects.
   * Requires authentication - only logged-in users can download files.
   *
   * GET /objects/:objectPath(*)
   */
  app.get("/objects/:objectPath(*)", requireAuth, async (req, res) => {
    try {
      const objectFile = await objectStorageService.getObjectEntityFile(req.path);
      const originalFilename = req.query.filename as string | undefined;
      await objectStorageService.downloadObject(objectFile, res, 3600, originalFilename);
    } catch (error) {
      console.error("Error serving object:", error);
      if (error instanceof ObjectNotFoundError) {
        return res.status(404).json({ error: "Object not found" });
      }
      return res.status(500).json({ error: "Failed to serve object" });
    }
  });
}

