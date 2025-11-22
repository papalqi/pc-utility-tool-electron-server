import { Response, NextFunction } from 'express';
import jwt, { SignOptions } from 'jsonwebtoken';
import { AuthRequest, JWTPayload, ApiResponse } from '../types';
import { config } from '../config';
import { logger } from '../utils/logger';

const log = logger.createScope('AuthMiddleware');

/**
 * Verify JWT token and attach user info to request
 */
export function authenticateToken(
  req: AuthRequest,
  res: Response<ApiResponse>,
  next: NextFunction
): void {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    res.status(401).json({
      success: false,
      error: 'No token provided',
    });
    return;
  }

  try {
    const payload = jwt.verify(token, config.jwt.secret) as JWTPayload;
    req.user = payload;
    next();
  } catch (error) {
    log.warn('Invalid token attempt', { error });
    res.status(403).json({
      success: false,
      error: 'Invalid or expired token',
    });
  }
}

/**
 * Generate JWT token for user
 */
export function generateToken(payload: JWTPayload): string {
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn as string | number,
  } as SignOptions);
}
