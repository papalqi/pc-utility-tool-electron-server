import { Router, Request, Response } from 'express';
import { LoginCredentials, RegisterData, ApiResponse, AuthResponse } from '../types';
import { userService } from '../services/userService';
import { generateToken } from '../middleware/auth';
import { logger } from '../utils/logger';

const log = logger.createScope('AuthRoutes');
const router = Router();

/**
 * POST /api/auth/register
 * Register a new user
 */
router.post('/register', async (req: Request<{}, {}, RegisterData>, res: Response<ApiResponse<AuthResponse>>) => {
  try {
    const { username, password } = req.body;

    // Validation
    if (!username || !password) {
      res.status(400).json({
        success: false,
        error: 'Username and password are required',
      });
      return;
    }

    if (username.length < 3) {
      res.status(400).json({
        success: false,
        error: 'Username must be at least 3 characters',
      });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({
        success: false,
        error: 'Password must be at least 6 characters',
      });
      return;
    }

    // Create user
    const user = await userService.createUser({ username, password });
    const token = generateToken({ userId: user.id, username: user.username });

    log.info(`User registered: ${username}`);

    res.status(201).json({
      success: true,
      data: {
        user: userService.toPublic(user),
        token,
      },
    });
  } catch (error) {
    log.error('Registration failed', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Registration failed',
    });
  }
});

/**
 * POST /api/auth/login
 * Login with username and password
 */
router.post('/login', async (req: Request<{}, {}, LoginCredentials>, res: Response<ApiResponse<AuthResponse>>) => {
  try {
    const { username, password } = req.body;

    // Validation
    if (!username || !password) {
      res.status(400).json({
        success: false,
        error: 'Username and password are required',
      });
      return;
    }

    // Find user
    const user = await userService.findByUsername(username);
    if (!user) {
      res.status(401).json({
        success: false,
        error: 'Invalid credentials',
      });
      return;
    }

    // Verify password
    const isValid = await userService.verifyPassword(user, password);
    if (!isValid) {
      res.status(401).json({
        success: false,
        error: 'Invalid credentials',
      });
      return;
    }

    // Generate token
    const token = generateToken({ userId: user.id, username: user.username });

    log.info(`User logged in: ${username}`);

    res.json({
      success: true,
      data: {
        user: userService.toPublic(user),
        token,
      },
    });
  } catch (error) {
    log.error('Login failed', error);
    res.status(500).json({
      success: false,
      error: 'Login failed',
    });
  }
});

export default router;
