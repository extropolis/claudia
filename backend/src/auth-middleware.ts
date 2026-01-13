import { Request, Response, NextFunction } from 'express';
import { AuthService } from './auth-service.js';
import { TokenPayload } from '@claudia/shared';

// Extend Express Request to include user data
declare global {
    namespace Express {
        interface Request {
            user?: TokenPayload;
        }
    }
}

/**
 * Middleware to authenticate requests using JWT tokens
 */
export function createAuthMiddleware(authService: AuthService) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            // Get token from Authorization header
            const authHeader = req.headers.authorization;

            if (!authHeader) {
                res.status(401).json({ error: 'No authorization header provided' });
                return;
            }

            // Check if it's a Bearer token
            const parts = authHeader.split(' ');
            if (parts.length !== 2 || parts[0] !== 'Bearer') {
                res.status(401).json({ error: 'Invalid authorization header format. Expected: Bearer <token>' });
                return;
            }

            const token = parts[1];

            // Verify token
            const payload = authService.verifyAccessToken(token);

            // Attach user info to request
            req.user = payload;

            next();
        } catch (error) {
            if (error instanceof Error) {
                if (error.message === 'Token expired') {
                    res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
                    return;
                } else if (error.message === 'Invalid token') {
                    res.status(401).json({ error: 'Invalid token', code: 'INVALID_TOKEN' });
                    return;
                }
            }
            res.status(401).json({ error: 'Authentication failed' });
        }
    };
}

/**
 * Optional authentication middleware - doesn't fail if no token is provided
 * but adds user info if a valid token is present
 */
export function createOptionalAuthMiddleware(authService: AuthService) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const authHeader = req.headers.authorization;

            if (authHeader) {
                const parts = authHeader.split(' ');
                if (parts.length === 2 && parts[0] === 'Bearer') {
                    const token = parts[1];
                    try {
                        const payload = authService.verifyAccessToken(token);
                        req.user = payload;
                    } catch {
                        // Ignore errors for optional auth
                    }
                }
            }

            next();
        } catch {
            // Ignore errors for optional auth
            next();
        }
    };
}
