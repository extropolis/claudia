import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import {
    User,
    UserDTO,
    AuthTokens,
    TokenPayload,
    RegisterRequest,
    LoginRequest,
    AuthResponse
} from '@claudia/shared';

export class AuthService {
    private users: Map<string, User> = new Map();
    private usersByEmail: Map<string, User> = new Map();
    private refreshTokens: Set<string> = new Set();

    // Configuration
    private readonly JWT_SECRET: string;
    private readonly JWT_REFRESH_SECRET: string;
    private readonly ACCESS_TOKEN_EXPIRY = '15m';
    private readonly REFRESH_TOKEN_EXPIRY = '7d';
    private readonly SALT_ROUNDS = 10;

    constructor() {
        // In production, these should come from environment variables
        this.JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
        this.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'your-refresh-secret-key-change-in-production';
    }

    /**
     * Hash a password using bcrypt
     */
    private async hashPassword(password: string): Promise<string> {
        return bcrypt.hash(password, this.SALT_ROUNDS);
    }

    /**
     * Compare a plain text password with a hashed password
     */
    private async comparePassword(password: string, hash: string): Promise<boolean> {
        return bcrypt.compare(password, hash);
    }

    /**
     * Generate access and refresh tokens for a user
     */
    private generateTokens(userId: string, email: string): AuthTokens {
        const accessTokenPayload: TokenPayload = {
            userId,
            email,
            type: 'access'
        };

        const refreshTokenPayload: TokenPayload = {
            userId,
            email,
            type: 'refresh'
        };

        const accessToken = jwt.sign(accessTokenPayload, this.JWT_SECRET, {
            expiresIn: this.ACCESS_TOKEN_EXPIRY
        });

        const refreshToken = jwt.sign(refreshTokenPayload, this.JWT_REFRESH_SECRET, {
            expiresIn: this.REFRESH_TOKEN_EXPIRY
        });

        // Store refresh token
        this.refreshTokens.add(refreshToken);

        return { accessToken, refreshToken };
    }

    /**
     * Convert User to UserDTO (remove sensitive data)
     */
    private toUserDTO(user: User): UserDTO {
        return {
            id: user.id,
            email: user.email,
            name: user.name,
            createdAt: user.createdAt
        };
    }

    /**
     * Register a new user
     */
    async register(data: RegisterRequest): Promise<AuthResponse> {
        // Check if user already exists
        if (this.usersByEmail.has(data.email)) {
            throw new Error('User with this email already exists');
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(data.email)) {
            throw new Error('Invalid email format');
        }

        // Validate password strength
        if (data.password.length < 8) {
            throw new Error('Password must be at least 8 characters long');
        }

        // Hash password
        const passwordHash = await this.hashPassword(data.password);

        // Create user
        const user: User = {
            id: uuidv4(),
            email: data.email,
            passwordHash,
            name: data.name,
            createdAt: new Date(),
            updatedAt: new Date()
        };

        // Store user
        this.users.set(user.id, user);
        this.usersByEmail.set(user.email, user);

        // Generate tokens
        const tokens = this.generateTokens(user.id, user.email);

        return {
            user: this.toUserDTO(user),
            tokens
        };
    }

    /**
     * Login a user
     */
    async login(data: LoginRequest): Promise<AuthResponse> {
        // Find user by email
        const user = this.usersByEmail.get(data.email);
        if (!user) {
            throw new Error('Invalid email or password');
        }

        // Verify password
        const isPasswordValid = await this.comparePassword(data.password, user.passwordHash);
        if (!isPasswordValid) {
            throw new Error('Invalid email or password');
        }

        // Update last login time
        user.updatedAt = new Date();

        // Generate tokens
        const tokens = this.generateTokens(user.id, user.email);

        return {
            user: this.toUserDTO(user),
            tokens
        };
    }

    /**
     * Verify an access token
     */
    verifyAccessToken(token: string): TokenPayload {
        try {
            const payload = jwt.verify(token, this.JWT_SECRET) as TokenPayload;

            if (payload.type !== 'access') {
                throw new Error('Invalid token type');
            }

            return payload;
        } catch (error) {
            if (error instanceof jwt.TokenExpiredError) {
                throw new Error('Token expired');
            } else if (error instanceof jwt.JsonWebTokenError) {
                throw new Error('Invalid token');
            }
            throw error;
        }
    }

    /**
     * Refresh access token using a refresh token
     */
    async refreshAccessToken(refreshToken: string): Promise<AuthTokens> {
        // Check if refresh token exists in our store
        if (!this.refreshTokens.has(refreshToken)) {
            throw new Error('Invalid refresh token');
        }

        try {
            const payload = jwt.verify(refreshToken, this.JWT_REFRESH_SECRET) as TokenPayload;

            if (payload.type !== 'refresh') {
                throw new Error('Invalid token type');
            }

            // Verify user still exists
            const user = this.users.get(payload.userId);
            if (!user) {
                throw new Error('User not found');
            }

            // Remove old refresh token
            this.refreshTokens.delete(refreshToken);

            // Generate new tokens
            const tokens = this.generateTokens(user.id, user.email);

            return tokens;
        } catch (error) {
            // Remove invalid token
            this.refreshTokens.delete(refreshToken);

            if (error instanceof jwt.TokenExpiredError) {
                throw new Error('Refresh token expired');
            } else if (error instanceof jwt.JsonWebTokenError) {
                throw new Error('Invalid refresh token');
            }
            throw error;
        }
    }

    /**
     * Logout a user by invalidating their refresh token
     */
    logout(refreshToken: string): void {
        this.refreshTokens.delete(refreshToken);
    }

    /**
     * Get user by ID
     */
    getUserById(userId: string): UserDTO | null {
        const user = this.users.get(userId);
        return user ? this.toUserDTO(user) : null;
    }

    /**
     * Get user by email
     */
    getUserByEmail(email: string): UserDTO | null {
        const user = this.usersByEmail.get(email);
        return user ? this.toUserDTO(user) : null;
    }

    /**
     * Get all users (admin function)
     */
    getAllUsers(): UserDTO[] {
        return Array.from(this.users.values()).map(user => this.toUserDTO(user));
    }
}
