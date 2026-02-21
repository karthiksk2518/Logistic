import crypto from "crypto";
import { db } from "./db";
import { apiLogs } from "@shared/schema";
import { SurepassEncryptedClient, SurepassError } from "./surepass-client";
import { createSurepassKycRequest, updateSurepassKycRequest } from "./surepass-storage";

type PanVerificationResult = {
  pan_number?: string;
  full_name?: string;
  category?: string;
  status?: string;
};

type VerifyPanInput = {
  panNumber: string;
  userId?: string;
  requestRef?: string;
};

function maskValue(value: string) {
  if (value.length <= 4) {
    return "*".repeat(value.length);
  }
  return `${value.slice(0, 2)}${"*".repeat(Math.max(0, value.length - 4))}${value.slice(-2)}`;
}

function hashValue(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sanitizePanRequest(panNumber: string) {
  return {
    pan_last4: panNumber.slice(-4),
    pan_masked: maskValue(panNumber),
    pan_hash: hashValue(panNumber),
  };
}

function sanitizePanResponse(data: PanVerificationResult | undefined) {
  if (!data) return undefined;
  return {
    ...data,
    pan_number: data.pan_number ? maskValue(data.pan_number) : undefined,
  };
}

async function logSurepassCall(input: {
  userId?: string;
  endpoint: string;
  method: string;
  requestBody?: unknown;
  responseBody?: unknown;
  statusCode?: number;
  errorMessage?: string;
  durationMs: number;
}) {
  await db.insert(apiLogs).values({
    userId: input.userId,
    endpoint: input.endpoint,
    method: input.method,
    requestBody: input.requestBody,
    responseBody: input.responseBody,
    statusCode: input.statusCode,
    errorMessage: input.errorMessage,
    durationMs: input.durationMs,
    logType: "surepass",
    createdAt: new Date(),
  });
}

export async function verifyPan(input: VerifyPanInput) {
  const client = SurepassEncryptedClient.fromEnv();
  const startedAt = Date.now();
  const maskedRequest = sanitizePanRequest(input.panNumber);
  const record = await createSurepassKycRequest({
    userId: input.userId,
    requestType: "pan",
    requestRef: input.requestRef,
    status: "pending",
    requestHash: maskedRequest.pan_hash,
    requestMasked: maskedRequest,
  });
  try {
    const response = await client.postJson<PanVerificationResult>("/api/v1/pan/pan", {
      pan_number: input.panNumber,
    });
    const sanitizedResponse = sanitizePanResponse(response.data);
    await updateSurepassKycRequest(record.id, {
      status: response.success ? "success" : "failed",
      responseStatusCode: response.status_code,
      responseMessageCode: response.message_code,
      responseMasked: sanitizedResponse ?? null,
    });
    await logSurepassCall({
      userId: input.userId,
      endpoint: "/api/v1/pan/pan",
      method: "POST",
      requestBody: maskedRequest,
      responseBody: sanitizedResponse ?? null,
      statusCode: response.status_code,
      durationMs: Date.now() - startedAt,
    });
    return response;
  } catch (error: any) {
    const message = error instanceof SurepassError ? error.message : "Surepass PAN verification failed";
    await updateSurepassKycRequest(record.id, {
      status: "failed",
      errorMessage: message,
    });
    await logSurepassCall({
      userId: input.userId,
      endpoint: "/api/v1/pan/pan",
      method: "POST",
      requestBody: maskedRequest,
      responseBody: null,
      statusCode: error?.status,
      errorMessage: message,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}
