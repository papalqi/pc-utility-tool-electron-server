# PC Utility Tool - File Server

A secure file server with user authentication for PC Utility Tool. Provides file upload/download services with user-based management.

## Features

- 🔐 **JWT Authentication** - Secure user authentication with JSON Web Tokens
- 📁 **File Management** - Upload, download, and delete files
- 👤 **User-Based Storage** - Each user has isolated file storage
- 🚀 **Cross-Platform** - Runs on Linux and Windows
- 🛡️ **Security** - Rate limiting, CORS, helmet protection
- 📊 **Storage Tracking** - Monitor storage usage per user

## Quick Start

### Installation

```bash
# Clone the repository
git clone git@github.com:papalqi/pc-utility-tool-electron-server.git
cd pc-utility-tool-electron-server

# Install dependencies
npm install
```

### Configuration

Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```env
PORT=3000
NODE_ENV=development
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
```

**⚠️ Important**: Change the default admin password before deploying to production!

### Development

```bash
# Start development server with hot reload
npm run dev
```

### Production

```bash
# Build TypeScript
npm run build

# Start production server
npm start
```

## API Documentation

### Base URL

```
http://localhost:3000/api
```

### Authentication

#### Register

Create a new user account.

**Endpoint**: `POST /api/auth/register`

**Request Body**:
```json
{
  "username": "user123",
  "password": "password123"
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid",
      "username": "user123",
      "createdAt": "2025-01-01T00:00:00.000Z",
      "updatedAt": "2025-01-01T00:00:00.000Z"
    },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

#### Login

Authenticate and receive a JWT token.

**Endpoint**: `POST /api/auth/login`

**Request Body**:
```json
{
  "username": "user123",
  "password": "password123"
}
```

**Response**:
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid",
      "username": "user123",
      "createdAt": "2025-01-01T00:00:00.000Z",
      "updatedAt": "2025-01-01T00:00:00.000Z"
    },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

### File Operations

All file endpoints require authentication. Include the JWT token in the Authorization header:

```
Authorization: Bearer <your-token>
```

#### Upload File

Upload a single file.

**Endpoint**: `POST /api/files/upload`

**Request**: `multipart/form-data`
- `file`: File to upload

**Example (curl)**:
```bash
curl -X POST http://localhost:3000/api/files/upload \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@/path/to/file.pdf"
```

**Response**:
```json
{
  "success": true,
  "data": {
    "id": "file-uuid",
    "originalName": "file.pdf",
    "filename": "unique-filename.pdf",
    "path": "/uploads/user-id/unique-filename.pdf",
    "size": 1024000,
    "mimetype": "application/pdf",
    "userId": "user-uuid",
    "uploadedAt": "2025-01-01T00:00:00.000Z"
  }
}
```

#### Upload Multiple Files

Upload multiple files at once (max 10 files).

**Endpoint**: `POST /api/files/upload-multiple`

**Request**: `multipart/form-data`
- `files`: Multiple files to upload

**Example (curl)**:
```bash
curl -X POST http://localhost:3000/api/files/upload-multiple \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "files=@/path/to/file1.pdf" \
  -F "files=@/path/to/file2.jpg"
```

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": "file-uuid-1",
      "originalName": "file1.pdf",
      ...
    },
    {
      "id": "file-uuid-2",
      "originalName": "file2.jpg",
      ...
    }
  ]
}
```

#### List Files

Get all files for the current user.

**Endpoint**: `GET /api/files`

**Example (curl)**:
```bash
curl -X GET http://localhost:3000/api/files \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": "file-uuid",
      "originalName": "file.pdf",
      "filename": "unique-filename.pdf",
      "path": "/uploads/user-id/unique-filename.pdf",
      "size": 1024000,
      "mimetype": "application/pdf",
      "userId": "user-uuid",
      "uploadedAt": "2025-01-01T00:00:00.000Z"
    }
  ]
}
```

#### Download File

Download a specific file.

**Endpoint**: `GET /api/files/:fileId`

**Example (curl)**:
```bash
curl -X GET http://localhost:3000/api/files/FILE_ID \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -O -J
```

**Response**: Binary file download

#### Delete File

Delete a specific file.

**Endpoint**: `DELETE /api/files/:fileId`

**Example (curl)**:
```bash
curl -X DELETE http://localhost:3000/api/files/FILE_ID \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Response**:
```json
{
  "success": true,
  "message": "File deleted successfully"
}
```

#### Get Storage Usage

Get storage usage statistics for the current user.

**Endpoint**: `GET /api/files/storage/usage`

**Example (curl)**:
```bash
curl -X GET http://localhost:3000/api/files/storage/usage \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Response**:
```json
{
  "success": true,
  "data": {
    "used": 5242880,
    "files": 3
  }
}
```

### Health Check

Check if the server is running.

**Endpoint**: `GET /health`

**Response**:
```json
{
  "success": true,
  "message": "Server is running",
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

## Client Integration Examples

### JavaScript/TypeScript

```typescript
class FileServerClient {
  private baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl: string = 'http://localhost:3000/api') {
    this.baseUrl = baseUrl;
  }

  async login(username: string, password: string) {
    const response = await fetch(`${this.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json();
    if (data.success) {
      this.token = data.data.token;
    }
    return data;
  }

  async uploadFile(file: File) {
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(`${this.baseUrl}/files/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.token}` },
      body: formData,
    });
    return response.json();
  }

  async listFiles() {
    const response = await fetch(`${this.baseUrl}/files`, {
      headers: { 'Authorization': `Bearer ${this.token}` },
    });
    return response.json();
  }

  async downloadFile(fileId: string) {
    const response = await fetch(`${this.baseUrl}/files/${fileId}`, {
      headers: { 'Authorization': `Bearer ${this.token}` },
    });
    return response.blob();
  }

  async deleteFile(fileId: string) {
    const response = await fetch(`${this.baseUrl}/files/${fileId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${this.token}` },
    });
    return response.json();
  }
}

// Usage
const client = new FileServerClient();
await client.login('admin', 'admin123');
const files = await client.listFiles();
```

### Python

```python
import requests

class FileServerClient:
    def __init__(self, base_url='http://localhost:3000/api'):
        self.base_url = base_url
        self.token = None

    def login(self, username, password):
        response = requests.post(
            f'{self.base_url}/auth/login',
            json={'username': username, 'password': password}
        )
        data = response.json()
        if data['success']:
            self.token = data['data']['token']
        return data

    def upload_file(self, file_path):
        with open(file_path, 'rb') as f:
            files = {'file': f}
            headers = {'Authorization': f'Bearer {self.token}'}
            response = requests.post(
                f'{self.base_url}/files/upload',
                headers=headers,
                files=files
            )
        return response.json()

    def list_files(self):
        headers = {'Authorization': f'Bearer {self.token}'}
        response = requests.get(f'{self.base_url}/files', headers=headers)
        return response.json()

    def download_file(self, file_id, save_path):
        headers = {'Authorization': f'Bearer {self.token}'}
        response = requests.get(f'{self.base_url}/files/{file_id}', headers=headers)
        with open(save_path, 'wb') as f:
            f.write(response.content)

    def delete_file(self, file_id):
        headers = {'Authorization': f'Bearer {self.token}'}
        response = requests.delete(f'{self.base_url}/files/{file_id}', headers=headers)
        return response.json()

# Usage
client = FileServerClient()
client.login('admin', 'admin123')
files = client.list_files()
```

## Project Structure

```
pc-utility-tool-electron-server/
├── src/
│   ├── config/           # Configuration
│   │   └── index.ts
│   ├── middleware/       # Express middleware
│   │   ├── auth.ts       # JWT authentication
│   │   └── upload.ts     # Multer file upload
│   ├── routes/           # API routes
│   │   ├── auth.ts       # Authentication endpoints
│   │   └── files.ts      # File management endpoints
│   ├── services/         # Business logic
│   │   ├── userService.ts
│   │   └── fileService.ts
│   ├── types/            # TypeScript types
│   │   └── index.ts
│   ├── utils/            # Utilities
│   │   └── logger.ts
│   └── index.ts          # Server entry point
├── data/                 # User and file metadata (auto-created)
├── uploads/              # Uploaded files (auto-created)
├── .env                  # Environment variables (create from .env.example)
├── .env.example          # Example environment variables
├── tsconfig.json         # TypeScript configuration
└── package.json          # Dependencies
```

## Security Considerations

1. **JWT Secret**: Use a strong, random secret in production
2. **Password**: Change the default admin password
3. **CORS**: Configure appropriate CORS origins for production
4. **HTTPS**: Use HTTPS in production (configure reverse proxy)
5. **File Size**: Adjust `MAX_FILE_SIZE` based on your needs
6. **Rate Limiting**: Adjust rate limits based on your traffic patterns
7. **File Types**: Consider adding file type restrictions in `upload.ts`

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `NODE_ENV` | Environment (development/production) | `development` |
| `JWT_SECRET` | Secret key for JWT tokens | `your-super-secret-jwt-key-change-this` |
| `JWT_EXPIRES_IN` | Token expiration time | `24h` |
| `UPLOAD_DIR` | Upload directory path | `./uploads` |
| `MAX_FILE_SIZE` | Max file size in bytes | `104857600` (100MB) |
| `ADMIN_USERNAME` | Default admin username | `admin` |
| `ADMIN_PASSWORD` | Default admin password | `admin123` |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window (ms) | `900000` (15min) |
| `RATE_LIMIT_MAX_REQUESTS` | Max requests per window | `100` |
| `CORS_ORIGIN` | Allowed CORS origins | `*` |

## Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build TypeScript to JavaScript
- `npm start` - Start production server
- `npm run type-check` - Check TypeScript types
- `npm run lint` - Lint code
- `npm run format` - Format code with Prettier

## License

MIT

## Author

papalqi
