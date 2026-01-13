import { Router, Request, Response } from 'express';
import { AuthService } from './auth-service.js';
import { createAuthMiddleware } from './auth-middleware.js';
import { LoginRequest, RegisterRequest, RefreshTokenRequest } from '@claudia/shared';

export function createAuthRoutes(authService: AuthService): Router {
    const router = Router();
    const authMiddleware = createAuthMiddleware(authService);

    /**
     * POST /auth/register
     * Register a new user
     */
    router.post('/register', async (req: Request, res: Response): Promise<void> => {
        try {
            const data: RegisterRequest = req.body;

            // Validate request body
            if (!data.email || !data.password) {
                res.status(400).json({ error: 'Email and password are required' });
                return;
            }

            const result = await authService.register(data);
            res.status(201).json(result);
        } catch (error) {
            if (error instanceof Error) {
                if (error.message.includes('already exists')) {
                    res.status(409).json({ error: error.message });
                    return;
                } else if (error.message.includes('Invalid') || error.message.includes('must be')) {
                    res.status(400).json({ error: error.message });
                    return;
                }
            }
            console.error('[Auth] Registration error:', error);
            res.status(500).json({ error: 'Registration failed' });
        }
    });

    /**
     * POST /auth/login
     * Login with email and password
     */
    router.post('/login', async (req: Request, res: Response): Promise<void> => {
        try {
            const data: LoginRequest = req.body;

            // Validate request body
            if (!data.email || !data.password) {
                res.status(400).json({ error: 'Email and password are required' });
                return;
            }

            const result = await authService.login(data);
            res.status(200).json(result);
        } catch (error) {
            if (error instanceof Error) {
                if (error.message.includes('Invalid email or password')) {
                    res.status(401).json({ error: error.message });
                    return;
                }
            }
            console.error('[Auth] Login error:', error);
            res.status(500).json({ error: 'Login failed' });
        }
    });

    /**
     * POST /auth/refresh
     * Refresh access token using refresh token
     */
    router.post('/refresh', async (req: Request, res: Response): Promise<void> => {
        try {
            const data: RefreshTokenRequest = req.body;

            // Validate request body
            if (!data.refreshToken) {
                res.status(400).json({ error: 'Refresh token is required' });
                return;
            }

            const tokens = await authService.refreshAccessToken(data.refreshToken);
            res.status(200).json({ tokens });
        } catch (error) {
            if (error instanceof Error) {
                if (error.message.includes('Invalid') || error.message.includes('expired')) {
                    res.status(401).json({ error: error.message });
                    return;
                }
            }
            console.error('[Auth] Token refresh error:', error);
            res.status(500).json({ error: 'Token refresh failed' });
        }
    });

    /**
     * POST /auth/logout
     * Logout user by invalidating refresh token
     */
    router.post('/logout', async (req: Request, res: Response): Promise<void> => {
        try {
            const data: RefreshTokenRequest = req.body;

            if (data.refreshToken) {
                authService.logout(data.refreshToken);
            }

            res.status(200).json({ message: 'Logged out successfully' });
        } catch (error) {
            console.error('[Auth] Logout error:', error);
            res.status(500).json({ error: 'Logout failed' });
        }
    });

    /**
     * GET /auth/me
     * Get current user info (requires authentication)
     */
    router.get('/me', authMiddleware, async (req: Request, res: Response): Promise<void> => {
        try {
            if (!req.user) {
                res.status(401).json({ error: 'Not authenticated' });
                return;
            }

            const user = authService.getUserById(req.user.userId);

            if (!user) {
                res.status(404).json({ error: 'User not found' });
                return;
            }

            res.status(200).json({ user });
        } catch (error) {
            console.error('[Auth] Get user error:', error);
            res.status(500).json({ error: 'Failed to get user info' });
        }
    });

    /**
     * GET /auth/users
     * Get all users (requires authentication)
     */
    router.get('/users', authMiddleware, async (req: Request, res: Response): Promise<void> => {
        try {
            const users = authService.getAllUsers();
            res.status(200).json({ users });
        } catch (error) {
            console.error('[Auth] Get users error:', error);
            res.status(500).json({ error: 'Failed to get users' });
        }
    });

    return router;
}
