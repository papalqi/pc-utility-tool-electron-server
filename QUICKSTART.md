# Quick Start Guide

## Installation & Running

```bash
# 1. Install dependencies
npm install

# 2. Start development server
npm run dev

# Server will start on http://localhost:3000
```

## Quick Test

```bash
# 1. Login (default admin account)
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'

# Response will include a token, use it in next requests
# Example token: eyJhbGci...

# 2. Upload a file
echo "Hello World" > sample.txt
curl -X POST http://localhost:3000/api/files/upload \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -F "file=@sample.txt"

# 3. List your files
curl http://localhost:3000/api/files \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"

# 4. Download a file (use file ID from list)
curl http://localhost:3000/api/files/FILE_ID \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -O -J

# 5. Check storage usage
curl http://localhost:3000/api/files/storage/usage \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

## Default Credentials

- **Username**: `admin`
- **Password**: `admin123`

⚠️ **Change the password before deploying to production!**

## Production Deployment

```bash
# 1. Build
npm run build

# 2. Set environment variables
export NODE_ENV=production
export JWT_SECRET=your-strong-secret-key
export ADMIN_PASSWORD=new-secure-password

# 3. Start
npm start
```

## API Endpoints

- `GET /health` - Health check
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login
- `POST /api/files/upload` - Upload single file
- `POST /api/files/upload-multiple` - Upload multiple files
- `GET /api/files` - List all user files
- `GET /api/files/:id` - Download file
- `DELETE /api/files/:id` - Delete file
- `GET /api/files/storage/usage` - Get storage statistics

See [README.md](README.md) for full documentation.
