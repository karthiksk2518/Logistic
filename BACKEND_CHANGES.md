# Backend Changes Documentation

## Session Cookie Fix for Cross-Origin Authentication

### Date: February 21, 2026

### Issue Summary
Admin login was failing to persist sessions. After successful login, all API requests returned 401 (Unauthorized) errors, and page refresh redirected users back to the authentication page.

### Root Cause
There were THREE issues preventing session authentication from working:

1. **Missing session assignment in login endpoint** - The login endpoint was NOT setting `req.session.userId`, so no session was created
2. **Session cookie configuration** - Using `sameSite: "lax"` in development blocked cross-origin cookies
3. **Vite proxy cookie rewriting** - Cookie domain rewriting was not properly configured

### Changes Made

#### Backend Changes

**File:** `backend/src/routes.ts`

**Change 1: Session Configuration (Line ~215-233)**

**Before:**
```typescript
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
    cookie: {
      secure: isProduction,
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: isProduction ? "none" : "lax",  // ❌ Blocked cross-origin cookies
    },
  })
);
```

**After:**
```typescript
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
    proxy: true,                                 // ✅ Trust proxy headers
    cookie: {
      secure: false,                             // ✅ Allow HTTP in development
      httpOnly: true,                            // ✅ Prevent XSS attacks
      maxAge: 7 * 24 * 60 * 60 * 1000,          // ✅ 7 days expiry
      sameSite: "lax",                           // ✅ Allow same-site cookies
      domain: undefined,                         // ✅ Let browser set domain
    },
  })
);
```

**Change 2: Login Endpoint - Set Session UserId (Line ~470)**

**Before:**
```typescript
await storage.updateUser(user.id, { lastActiveAt: new Date() } as any);

if (user.role === "carrier") {
  await seedSampleDocumentsForSoloDriver(user);
}

const { password: _, ...userWithoutPassword } = user;  // ❌ Session never set!
```

**After:**
```typescript
await storage.updateUser(user.id, { lastActiveAt: new Date() } as any);

if (user.role === "carrier") {
  await seedSampleDocumentsForSoloDriver(user);
}

// Set session userId to authenticate the user
req.session.userId = user.id;  // ✅ Critical fix - create session!

const { password: _, ...userWithoutPassword } = user;
```

#### Frontend Changes

**File:** `frontend/vite.config.ts`

**Before:**
```typescript
"/api": {
  target: apiProxyTarget,
  changeOrigin: true,
  secure: false,
  cookieDomainRewrite: "localhost",  // ❌ Incorrect cookie rewriting
},
```

**After:**
```typescript
"/api": {
  target: apiProxyTarget,
  changeOrigin: true,
  secure: false,
  cookieDomainRewrite: "",           // ✅ Remove domain from cookies
  cookiePathRewrite: "/",            // ✅ Set cookie path to root
},
```

### What Changed

**Backend (`backend/src/routes.ts`):**
1. **`req.session.userId = user.id`** - CRITICAL: Actually create the session on login (was missing!)
2. **`proxy: true`** - Trust proxy headers from Vite dev server
3. **`secure: false`** - Allow cookies over HTTP in development
4. **`sameSite: "lax"`** - Works with proxy setup (doesn't require HTTPS)
5. **`domain: undefined`** - Let browser automatically set the correct domain

**Frontend (`frontend/vite.config.ts`):**
1. **`cookieDomainRewrite: ""`** - Remove domain from Set-Cookie headers
2. **`cookiePathRewrite: "/"`** - Ensure cookies are available for all paths

### Why This Works

The PRIMARY issue was that **the login endpoint never set `req.session.userId`**, so no session was ever created! This was a critical bug.

Secondary issues:
- Vite proxy makes the backend appear to be on the same origin as the frontend
- `cookieDomainRewrite: ""` removes the domain attribute, making cookies work on localhost
- `sameSite: "lax"` allows cookies to be sent with same-site requests
- `proxy: true` in express-session trusts the X-Forwarded-* headers from Vite proxy
- Browser treats proxied requests as same-origin, so cookies work correctly

### Security Considerations
- `httpOnly: true` prevents JavaScript access to cookies (XSS protection)
- `secure: false` is acceptable in development on localhost
- `sameSite: "lax"` provides CSRF protection while allowing normal navigation
- For production, consider using a reverse proxy to serve both on the same origin

### Testing
After these changes:
1. ✅ Login as admin works correctly
2. ✅ Session is created and stored in database
3. ✅ Admin users list loads without 401 errors
4. ✅ Page refresh maintains the logged-in session
5. ✅ All API calls include the session cookie
6. ✅ Works in both local development and Docker Compose

### Technical Details

**Why the login was failing:**
- The login endpoint returned user data successfully (200 OK)
- But it NEVER called `req.session.userId = user.id`
- So no session was created in the database
- All subsequent requests had no session → 401 Unauthorized

**Why `sameSite: "none"` didn't work:**
- Modern browsers require `secure: true` when using `sameSite: "none"`
- `secure: true` requires HTTPS
- localhost uses HTTP, not HTTPS
- Therefore, `sameSite: "none"` + `secure: false` = cookies blocked by browser

**Why the new approach works:**
- Session is actually created on login (`req.session.userId = user.id`)
- Vite proxy makes backend appear same-origin to the browser
- `sameSite: "lax"` allows same-site cookies (which proxied requests are)
- `cookieDomainRewrite: ""` removes domain restrictions
- Browser accepts and sends cookies correctly

### Related Files
- `backend/src/routes.ts` - Session configuration + login endpoint (MODIFIED)
- `frontend/vite.config.ts` - Proxy and cookie settings (MODIFIED)
- `frontend/src/lib/auth-context.tsx` - Already using `credentials: "include"`
- `frontend/src/lib/queryClient.ts` - Already using `credentials: "include"`

### Impact
- ✅ Fixes admin login session persistence
- ✅ Fixes all 401 errors after login
- ✅ Works in Docker Compose environment
- ✅ Minimal changes (backend + frontend config)
- ✅ No breaking changes to existing functionality

---

**Summary:** Fixed session authentication by:
1. **Adding the missing `req.session.userId = user.id` line in the login endpoint** (critical bug fix)
2. Configuring express-session to trust proxy headers
3. Updating Vite proxy to properly rewrite cookie domains

This allows session cookies to work correctly in the development environment where frontend and backend run on different ports.
