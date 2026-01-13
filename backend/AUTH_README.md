# Authentication Module

This document describes the authentication system implemented in the backend API.

## Overview

The authentication module provides JWT-based authentication with the following features:

- User registration and login
- Access and refresh tokens
- Password hashing with bcrypt
- Token refresh mechanism
- Protected API routes
- Optional authentication for flexible endpoints

## Components

### 1. AuthService (`src/auth-service.ts`)

Core service handling authentication logic:

- **User Management**: Register, login, and user retrieval
- **Password Hashing**: Secure password storage using bcrypt
- **Token Generation**: Create JWT access and refresh tokens
- **Token Verification**: Validate tokens and extract user information
- **Token Refresh**: Generate new access tokens using refresh tokens

### 2. Auth Middleware (`src/auth-middleware.ts`)

Express middleware for protecting routes:

- **createAuthMiddleware**: Requires valid authentication token
- **createOptionalAuthMiddleware**: Adds user info if token present, but doesn't fail if missing

### 3. Auth Routes (`src/auth-routes.ts`)

REST API endpoints for authentication:

- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user
- `POST /api/auth/refresh` - Refresh access token
- `POST /api/auth/logout` - Logout user (invalidate refresh token)
- `GET /api/auth/me` - Get current user info (protected)
- `GET /api/auth/users` - Get all users (protected)

### 4. Types (`src/types.ts`)

TypeScript interfaces for type safety:

- `User` - Internal user representation
- `UserDTO` - User data transfer object (no password)
- `AuthTokens` - Access and refresh tokens
- `TokenPayload` - JWT token payload structure
- `LoginRequest` - Login request body
- `RegisterRequest` - Registration request body
- `RefreshTokenRequest` - Token refresh request body
- `AuthResponse` - Authentication response

## API Usage

### 1. Register a New User

```bash
POST /api/auth/register
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securepassword123",
  "name": "John Doe"
}
```

**Response:**
```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "name": "John Doe",
    "createdAt": "2024-01-01T00:00:00.000Z"
  },
  "tokens": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

### 2. Login

```bash
POST /api/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securepassword123"
}
```

**Response:** Same as registration

### 3. Refresh Access Token

```bash
POST /api/auth/refresh
Content-Type: application/json

{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Response:**
```json
{
  "tokens": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

### 4. Get Current User Info

```bash
GET /api/auth/me
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Response:**
```json
{
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "name": "John Doe",
    "createdAt": "2024-01-01T00:00:00.000Z"
  }
}
```

### 5. Logout

```bash
POST /api/auth/logout
Content-Type: application/json

{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Response:**
```json
{
  "message": "Logged out successfully"
}
```

## Using Protected Routes

To access protected routes, include the access token in the Authorization header:

```bash
GET /api/protected-route
Authorization: Bearer <your-access-token>
```

## Token Lifecycle

1. **Access Token**: Valid for 15 minutes
   - Used for authenticating API requests
   - Short-lived for security

2. **Refresh Token**: Valid for 7 days
   - Used to obtain new access tokens
   - Long-lived for better UX
   - Stored securely and invalidated on logout

## Security Features

- **Password Hashing**: bcrypt with 10 salt rounds
- **JWT Tokens**: Signed with secret keys
- **Token Type Validation**: Ensures access/refresh tokens are used correctly
- **Token Expiration**: Automatic expiration handling
- **Email Validation**: Basic email format validation
- **Password Requirements**: Minimum 8 characters

## Configuration

Set the following environment variables (defaults are provided for development):

```bash
JWT_SECRET=your-secret-key-change-in-production
JWT_REFRESH_SECRET=your-refresh-secret-key-change-in-production
```

## Integration in Existing Routes

All existing API routes have been updated with optional authentication:

- `/api/tasks/*` - Task management routes
- `/api/chat` - Chat route
- `/api/todos/*` - Todo management routes

These routes work without authentication but can extract user information if a valid token is provided.

## Error Handling

The API returns appropriate HTTP status codes:

- `200` - Success
- `201` - Created (registration)
- `400` - Bad request (validation errors)
- `401` - Unauthorized (invalid/expired token)
- `404` - Not found
- `409` - Conflict (user already exists)
- `500` - Internal server error

Error responses include descriptive messages:

```json
{
  "error": "Token expired",
  "code": "TOKEN_EXPIRED"
}
```

## Example Client Integration

```typescript
class AuthClient {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;

  async register(email: string, password: string, name?: string) {
    const response = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name })
    });
    const data = await response.json();
    this.accessToken = data.tokens.accessToken;
    this.refreshToken = data.tokens.refreshToken;
    return data.user;
  }

  async login(email: string, password: string) {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await response.json();
    this.accessToken = data.tokens.accessToken;
    this.refreshToken = data.tokens.refreshToken;
    return data.user;
  }

  async refreshAccessToken() {
    if (!this.refreshToken) throw new Error('No refresh token');

    const response = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: this.refreshToken })
    });
    const data = await response.json();
    this.accessToken = data.tokens.accessToken;
    this.refreshToken = data.tokens.refreshToken;
  }

  async makeAuthenticatedRequest(url: string, options: RequestInit = {}) {
    const headers = {
      ...options.headers,
      'Authorization': `Bearer ${this.accessToken}`
    };

    let response = await fetch(url, { ...options, headers });

    // If token expired, try to refresh
    if (response.status === 401) {
      const error = await response.json();
      if (error.code === 'TOKEN_EXPIRED') {
        await this.refreshAccessToken();
        headers['Authorization'] = `Bearer ${this.accessToken}`;
        response = await fetch(url, { ...options, headers });
      }
    }

    return response;
  }

  async logout() {
    if (this.refreshToken) {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.refreshToken })
      });
    }
    this.accessToken = null;
    this.refreshToken = null;
  }
}
```

## Notes

- The current implementation uses in-memory storage for users and tokens
- For production, integrate with a database (PostgreSQL, MongoDB, etc.)
- For production, use environment variables for JWT secrets
- Consider implementing rate limiting on auth endpoints
- Consider adding email verification for registration
- Consider adding password reset functionality
