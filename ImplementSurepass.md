🔑 Security
Surepass Encrypted API Integration Guide
📋 Overview
This guide provides comprehensive instructions for integrating with the Surepass Encrypted API, which uses RSA-2048 + AES-256-GCM encryption to secure all data transmission between your application and our services.
Prerequisites
Before starting your integration, ensure you have:
Valid Surepass API credentials (Bearer token)
Your assigned Client ID
RSA key pair provided by Surepass
Basic understanding of HTTP APIs and encryption concepts
🔑 Security Keys Setup
Your Surepass representative will provide three essential components:
client-id: your-company@surepass.io
client-private-key.pem - Your private key (keep secure!)
surepass-public-key.pem - Surepass public key (for encryption)
Important: Never commit private keys to version control or log them in your application.
Environment Configuration
Store your credentials securely using environment variables:
export SUREPASS_CLIENT_ID="your-company@surepass.io"
export SUREPASS_CLIENT_PRIVATE_KEY="$(cat client-private-key.pem)"
export SUREPASS_PUBLIC_KEY="$(cat surepass-public-key.pem)"
export SUREPASS_API_TOKEN="your-bearer-token"
Environment	API Base URL
Sandbox	https://sandbox-encrypted.surepass.app
Production	https://kyc-api-encrypted.surepass.app
Superflow Sandbox	https://superflow-sandbox-encrypted.surepass.app
Superflow Prod	https://superflow-encrypted.surepass.app
API Flow Comparison
Your App → Encrypt Request → HTTPS → Decrypt → Surepass API
                                                              ↓
Your App ← Decrypt Response ← HTTPS ← Encrypt ← Response
Enhanced security with end-to-end encryption using RSA + AES hybrid encryption.
Request Format Structure
1
Prepare Your Data
Create your request payload as usual (JSON, form-data, etc.)
2
Encrypt the Payload
Generate random AES-256 key and IV
Encrypt your data with AES-256-GCM
Encrypt the AES key with Surepass's RSA public key
Combine into encrypted payload format
3
Set Required Headers
POST /api/v1/pan/pan HTTP/1.1
Host: kyc-api-encrypted.surepass.io
Authorization: Bearer YOUR_API_TOKEN
x-client-id: your-company@surepass.io
Content-Type: text/plain
x-content-type: application/json
x-content-length: 27
4
Send Encrypted Request
The request body contains the encrypted payload string in the format:
encrypted_aes_key:iv:encrypted_data:auth_tag
Response Handling
📥 Decryption Process
1.
Receive encrypted response (HTTP 200)
2.
Extract AES key, IV, data, and auth tag from response
3.
Decrypt AES key using your RSA private key
4.
Decrypt response data using AES-256-GCM
5.
Parse the decrypted JSON data
Language-Specific Integration
Installation
npm install axios form-data
Basic Implementation
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');

class SurepassEncryptedAPI {
    constructor(clientId, apiToken, privateKeyPath, publicKeyPath) {
        this.clientId = clientId;
        this.apiToken = apiToken;
        this.baseUrl = 'https://kyc-api-encrypted.surepass.io';
        this.privateKey = fs.readFileSync(privateKeyPath);
        this.publicKey = fs.readFileSync(publicKeyPath);
    }
    
    encryptData(data) {
        // Generate AES key and IV
        const aesKey = crypto.randomBytes(32);
        const iv = crypto.randomBytes(12);
        
        // Encrypt data with AES-256-GCM
        const cipher = crypto.createCipherGCM('aes-256-gcm', aesKey);
        cipher.setAAD(Buffer.alloc(0));
        cipher.update(iv);
        const encryptedData = Buffer.concat([
            cipher.update(data, 'utf8'), 
            cipher.final()
        ]);
        const authTag = cipher.getAuthTag();
        
        // Encrypt AES key with RSA
        const encryptedAesKey = crypto.publicEncrypt({
            key: this.publicKey,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256'
        }, aesKey);
        
        return [
            encryptedAesKey.toString('base64'),
            iv.toString('base64'),
            encryptedData.toString('base64'),
            authTag.toString('base64')
        ].join(':');
    }
    
    decryptResponse(encryptedResponse) {
        const parts = encryptedResponse.split(':');
        
        // Decrypt AES key
        const decryptedAesKey = crypto.privateDecrypt({
            key: this.privateKey,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256'
        }, Buffer.from(parts[0], 'base64'));
        
        // Decrypt data
        const iv = Buffer.from(parts[1], 'base64');
        const encryptedData = Buffer.from(parts[2], 'base64');
        const authTag = Buffer.from(parts[3], 'base64');
        
        const decipher = crypto.createDecipherGCM('aes-256-gcm', decryptedAesKey);
        decipher.setAAD(Buffer.alloc(0));
        decipher.update(iv);
        decipher.setAuthTag(authTag);
        
        const decryptedData = Buffer.concat([
            decipher.update(encryptedData),
            decipher.final()
        ]);
        
        return JSON.parse(decryptedData.toString());
    }
    
    async makeRequest(endpoint, data) {
        const payload = JSON.stringify(data);
        const encryptedPayload = this.encryptData(payload);
        
        const headers = {
            'Authorization': `Bearer ${this.apiToken}`,
            'x-client-id': this.clientId,
            'Content-Type': 'text/plain',
            'x-content-type': 'application/json',
            'x-content-length': payload.length.toString()
        };
        
        const response = await axios.post(
            `${this.baseUrl}${endpoint}`,
            encryptedPayload,
            { headers }
        );
        
        return this.decryptResponse(response.data);
    }
}

// Usage Example
const api = new SurepassEncryptedAPI(
    'your-company@surepass.io',
    'your-bearer-token',
    'client-private-key.pem',
    'surepass-public-key.pem'
);

// PAN Verification
api.makeRequest('/api/v1/pan/pan', { pan_number: 'ABCDE1234F' })
    .then(result => {
        console.log(`PAN: ${result.data.pan_number}`);
        console.log(`Name: ${result.data.full_name}`);
    })
    .catch(error => console.error('Error:', error.message));
Testing Your Integration
1
Test PAN Verification
{
  "pan_number": "ABCDE1234F"
}
Expected response should return PAN details with success status.
2
Test File Upload (PAN OCR)
Upload a sample PAN card image to test OCR functionality.
Expected response should include extracted PAN information with confidence scores.
3
Verify Response Format
Ensure decrypted responses match the standard API format:
{
  "success": true,
  "status_code": 200,
  "data": { ... },
  "message": null,
  "message_code": "success"
}
Encryption Public Keys
Public Key Description	Link	URL
Superflow Production Public Key	Link	https://cdn.surepass.app/public-keys/superflow-production-at-surepass.app-public-key.pem
Superflow Sandbox Public Key	Link	https://cdn.surepass.app/public-keys/superflow-sandbox-at-surepass.app-public-key.pem
Surepass Production Public Key	Link	https://cdn.surepass.app/public-keys/surepass-production-at-surepass.app-public-key.pem
Surepass Sandbox Public Key	Link	https://cdn.surepass.app/public-keys/surepass-sandbox-at-surepass.app-public-key.pem
Security Best Practices
🔒 Security Guidelines
Never log private keys or decrypted sensitive data
Validate certificates during HTTPS requests
Use secure key storage (environment variables, key vaults)
Rotate keys regularly as advised by Surepass
Implement proper error handling without exposing sensitive information
Performance Optimization
⚡ Performance Tips
Cache key objects instead of re-importing PEM keys for each request
Reuse HTTP connections for multiple requests
Consider async/parallel processing for batch operations
Implement connection pooling for high-volume applications
Common Issues & Solutions
Issue: Decryption fails or returns garbled data
Solutions:
Verify client ID matches registered public key
Ensure private key corresponds to registered public key
Check AES key generation and IV handling
Validate auth tag extraction and verification

SUREPASS_CLIENT_ID="sabhyata.mehta@surepass.io"
SUREPASS_CLIENT_PRIVATE_KEY="$(cat sandbox_private_key.pem)"
SUREPASS_PUBLIC_KEY="$(cat sandbox_public_key.pem)"
SUREPASS_API_TOKEN="your-bearer-token"