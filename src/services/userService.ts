import fs from 'fs/promises';
import path from 'path';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { User, UserPublic, RegisterData } from '../types';
import { logger } from '../utils/logger';

const log = logger.createScope('UserService');

/**
 * User service - manages user data
 * In production, replace with a proper database
 */
class UserService {
  private usersFile: string;
  private users: Map<string, User>;

  constructor() {
    this.usersFile = path.join(process.cwd(), 'data', 'users.json');
    this.users = new Map();
  }

  /**
   * Initialize user service
   */
  async initialize(): Promise<void> {
    await this.ensureDataDirectory();
    await this.loadUsers();
    log.info('User service initialized');
  }

  /**
   * Ensure data directory exists
   */
  private async ensureDataDirectory(): Promise<void> {
    const dataDir = path.dirname(this.usersFile);
    try {
      await fs.access(dataDir);
    } catch {
      await fs.mkdir(dataDir, { recursive: true });
      log.info('Created data directory');
    }
  }

  /**
   * Load users from file
   */
  private async loadUsers(): Promise<void> {
    try {
      const data = await fs.readFile(this.usersFile, 'utf-8');
      const usersArray: User[] = JSON.parse(data);
      this.users = new Map(usersArray.map(user => [user.id, user]));
      log.info(`Loaded ${this.users.size} users`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        log.info('No existing users file, starting fresh');
        this.users = new Map();
      } else {
        log.error('Failed to load users', error);
        throw error;
      }
    }
  }

  /**
   * Save users to file
   */
  private async saveUsers(): Promise<void> {
    try {
      const usersArray = Array.from(this.users.values());
      await fs.writeFile(this.usersFile, JSON.stringify(usersArray, null, 2), 'utf-8');
      log.debug('Users saved to file');
    } catch (error) {
      log.error('Failed to save users', error);
      throw error;
    }
  }

  /**
   * Create a new user
   */
  async createUser(data: RegisterData): Promise<User> {
    // Check if username already exists
    const existing = Array.from(this.users.values()).find(
      u => u.username.toLowerCase() === data.username.toLowerCase()
    );
    if (existing) {
      throw new Error('Username already exists');
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(data.password, 10);

    // Create user
    const user: User = {
      id: uuidv4(),
      username: data.username,
      password: hashedPassword,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.users.set(user.id, user);
    await this.saveUsers();

    log.info(`User created: ${user.username}`);
    return user;
  }

  /**
   * Find user by username
   */
  async findByUsername(username: string): Promise<User | null> {
    const user = Array.from(this.users.values()).find(
      u => u.username.toLowerCase() === username.toLowerCase()
    );
    return user || null;
  }

  /**
   * Find user by ID
   */
  async findById(id: string): Promise<User | null> {
    return this.users.get(id) || null;
  }

  /**
   * Verify user password
   */
  async verifyPassword(user: User, password: string): Promise<boolean> {
    return bcrypt.compare(password, user.password);
  }

  /**
   * Update user password (rehash and persist)
   */
  async updatePassword(userId: string, password: string): Promise<void> {
    const user = await this.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const updated: User = {
      ...user,
      password: hashedPassword,
      updatedAt: new Date(),
    };

    this.users.set(updated.id, updated);
    await this.saveUsers();
  }

  /**
   * Convert User to UserPublic (remove sensitive data)
   */
  toPublic(user: User): UserPublic {
    return {
      id: user.id,
      username: user.username,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  /**
   * Get all users (admin only)
   */
  async getAllUsers(): Promise<UserPublic[]> {
    return Array.from(this.users.values()).map(user => this.toPublic(user));
  }
}

export const userService = new UserService();
