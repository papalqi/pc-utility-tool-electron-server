import { Request } from 'express';

/**
 * User data structure
 */
export interface User {
  id: string;
  username: string;
  password: string; // bcrypt hashed
  createdAt: Date;
  updatedAt: Date;
}

/**
 * User without sensitive data (for API responses)
 */
export interface UserPublic {
  id: string;
  username: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * JWT payload structure
 */
export interface JWTPayload {
  userId: string;
  username: string;
}

/**
 * File metadata
 */
export interface FileMetadata {
  id: string;
  originalName: string;
  filename: string;
  path: string;
  size: number;
  mimetype: string;
  userId: string;
  uploadedAt: Date;
}

/**
 * Extended Express Request with user info
 */
export interface AuthRequest extends Request {
  user?: JWTPayload;
}

/**
 * API Response wrapper
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

/**
 * Login credentials
 */
export interface LoginCredentials {
  username: string;
  password: string;
}

/**
 * Register data
 */
export interface RegisterData {
  username: string;
  password: string;
}

/**
 * Auth response
 */
export interface AuthResponse {
  user: UserPublic;
  token: string;
}
