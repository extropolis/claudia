# Authentication Examples

This document provides practical examples of using the authentication API.

## Prerequisites

Start the server:
```bash
npm run dev
```

The API will be available at `http://localhost:3000` (or your configured port).

## Example 1: Registration Flow

### Using cURL

```bash
# Register a new user
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john@example.com",
    "password": "securepass123",
    "name": "John Doe"
  }'
```

**Response:**
```json
{
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "john@example.com",
    "name": "John Doe",
    "createdAt": "2024-01-10T12:00:00.000Z"
  },
  "tokens": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

### Using JavaScript/Fetch

```javascript
async function register(email, password, name) {
  const response = await fetch('http://localhost:3000/api/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, name })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error);
  }

  const data = await response.json();

  // Store tokens (e.g., in localStorage)
  localStorage.setItem('accessToken', data.tokens.accessToken);
  localStorage.setItem('refreshToken', data.tokens.refreshToken);

  return data.user;
}

// Usage
register('john@example.com', 'securepass123', 'John Doe')
  .then(user => console.log('Registered:', user))
  .catch(err => console.error('Error:', err.message));
```

## Example 2: Login Flow

### Using cURL

```bash
# Login
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john@example.com",
    "password": "securepass123"
  }'
```

### Using JavaScript/Fetch

```javascript
async function login(email, password) {
  const response = await fetch('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error);
  }

  const data = await response.json();

  // Store tokens
  localStorage.setItem('accessToken', data.tokens.accessToken);
  localStorage.setItem('refreshToken', data.tokens.refreshToken);

  return data.user;
}

// Usage
login('john@example.com', 'securepass123')
  .then(user => console.log('Logged in:', user))
  .catch(err => console.error('Error:', err.message));
```

## Example 3: Making Authenticated Requests

### Using cURL

```bash
# Get current user info
ACCESS_TOKEN="your-access-token-here"

curl -X GET http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

### Using JavaScript/Fetch

```javascript
async function getCurrentUser() {
  const accessToken = localStorage.getItem('accessToken');

  const response = await fetch('http://localhost:3000/api/auth/me', {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error);
  }

  const data = await response.json();
  return data.user;
}

// Usage
getCurrentUser()
  .then(user => console.log('Current user:', user))
  .catch(err => console.error('Error:', err.message));
```

## Example 4: Token Refresh Flow

### Using cURL

```bash
# Refresh access token
REFRESH_TOKEN="your-refresh-token-here"

curl -X POST http://localhost:3000/api/auth/refresh \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\": \"$REFRESH_TOKEN\"}"
```

### Using JavaScript/Fetch

```javascript
async function refreshAccessToken() {
  const refreshToken = localStorage.getItem('refreshToken');

  const response = await fetch('http://localhost:3000/api/auth/refresh', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ refreshToken })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error);
  }

  const data = await response.json();

  // Update stored tokens
  localStorage.setItem('accessToken', data.tokens.accessToken);
  localStorage.setItem('refreshToken', data.tokens.refreshToken);

  return data.tokens;
}

// Usage
refreshAccessToken()
  .then(tokens => console.log('Tokens refreshed'))
  .catch(err => console.error('Error:', err.message));
```

## Example 5: Complete Auth Client with Auto-Refresh

```javascript
class AuthClient {
  constructor(baseURL = 'http://localhost:3000') {
    this.baseURL = baseURL;
  }

  // Get stored tokens
  getAccessToken() {
    return localStorage.getItem('accessToken');
  }

  getRefreshToken() {
    return localStorage.getItem('refreshToken');
  }

  // Store tokens
  setTokens(accessToken, refreshToken) {
    localStorage.setItem('accessToken', accessToken);
    localStorage.setItem('refreshToken', refreshToken);
  }

  // Clear tokens
  clearTokens() {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
  }

  // Register
  async register(email, password, name) {
    const response = await fetch(`${this.baseURL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    this.setTokens(data.tokens.accessToken, data.tokens.refreshToken);
    return data.user;
  }

  // Login
  async login(email, password) {
    const response = await fetch(`${this.baseURL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    this.setTokens(data.tokens.accessToken, data.tokens.refreshToken);
    return data.user;
  }

  // Refresh tokens
  async refreshTokens() {
    const refreshToken = this.getRefreshToken();
    if (!refreshToken) throw new Error('No refresh token available');

    const response = await fetch(`${this.baseURL}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    this.setTokens(data.tokens.accessToken, data.tokens.refreshToken);
    return data.tokens;
  }

  // Logout
  async logout() {
    const refreshToken = this.getRefreshToken();
    if (refreshToken) {
      await fetch(`${this.baseURL}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken })
      });
    }
    this.clearTokens();
  }

  // Make authenticated request with auto-retry on token expiration
  async authenticatedRequest(url, options = {}) {
    const makeRequest = async (token) => {
      const headers = {
        ...options.headers,
        'Authorization': `Bearer ${token}`
      };

      return fetch(url, { ...options, headers });
    };

    // Try with current token
    let response = await makeRequest(this.getAccessToken());

    // If token expired, refresh and retry once
    if (response.status === 401) {
      const error = await response.json();
      if (error.code === 'TOKEN_EXPIRED') {
        try {
          await this.refreshTokens();
          response = await makeRequest(this.getAccessToken());
        } catch (refreshError) {
          // Refresh failed, clear tokens and throw
          this.clearTokens();
          throw new Error('Session expired. Please login again.');
        }
      }
    }

    return response;
  }

  // Get current user
  async getCurrentUser() {
    const response = await this.authenticatedRequest(
      `${this.baseURL}/api/auth/me`
    );

    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    return data.user;
  }
}

// Usage example
const authClient = new AuthClient();

// Register
await authClient.register('user@example.com', 'password123', 'User Name');

// Login
await authClient.login('user@example.com', 'password123');

// Make authenticated request to any endpoint
const response = await authClient.authenticatedRequest(
  'http://localhost:3000/api/tasks'
);
const tasks = await response.json();

// Get current user
const user = await authClient.getCurrentUser();

// Logout
await authClient.logout();
```

## Example 6: React Hook for Authentication

```javascript
import { useState, useEffect, createContext, useContext } from 'react';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const authClient = new AuthClient();

  useEffect(() => {
    // Check if user is logged in on mount
    const checkAuth = async () => {
      try {
        const currentUser = await authClient.getCurrentUser();
        setUser(currentUser);
      } catch (error) {
        console.error('Not authenticated');
      } finally {
        setLoading(false);
      }
    };

    checkAuth();
  }, []);

  const login = async (email, password) => {
    const user = await authClient.login(email, password);
    setUser(user);
    return user;
  };

  const register = async (email, password, name) => {
    const user = await authClient.register(email, password, name);
    setUser(user);
    return user;
  };

  const logout = async () => {
    await authClient.logout();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, login, register, logout, loading, authClient }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}

// Usage in components
function LoginForm() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      await login(email, password);
      // Redirect or show success
    } catch (error) {
      console.error('Login failed:', error);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
      />
      <button type="submit">Login</button>
    </form>
  );
}
```

## Error Handling

Common error responses:

```javascript
// 400 - Bad Request
{
  "error": "Email and password are required"
}

// 401 - Unauthorized
{
  "error": "Invalid email or password"
}

// 401 - Token Expired
{
  "error": "Token expired",
  "code": "TOKEN_EXPIRED"
}

// 409 - Conflict
{
  "error": "User with this email already exists"
}
```

## Testing with Postman

1. **Import the collection**: Create a new collection in Postman

2. **Add environment variables**:
   - `baseURL`: `http://localhost:3000`
   - `accessToken`: (will be set automatically)
   - `refreshToken`: (will be set automatically)

3. **Register request**:
   - Method: POST
   - URL: `{{baseURL}}/api/auth/register`
   - Body: Raw JSON
   ```json
   {
     "email": "test@example.com",
     "password": "password123",
     "name": "Test User"
   }
   ```
   - Tests tab:
   ```javascript
   pm.environment.set("accessToken", pm.response.json().tokens.accessToken);
   pm.environment.set("refreshToken", pm.response.json().tokens.refreshToken);
   ```

4. **Authenticated request**:
   - Method: GET
   - URL: `{{baseURL}}/api/auth/me`
   - Authorization: Bearer Token
   - Token: `{{accessToken}}`

## Security Best Practices

1. **Always use HTTPS in production**
2. **Store tokens securely** (consider httpOnly cookies for web)
3. **Implement token rotation** on refresh
4. **Add rate limiting** on auth endpoints
5. **Use strong JWT secrets** (set via environment variables)
6. **Validate input** on the client side
7. **Implement CSRF protection** if using cookies
8. **Log authentication events** for security monitoring
