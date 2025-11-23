# 客户端 API 使用指南

## 📋 目录

1. [认证](#认证)
2. [文件上传](#文件上传)
3. [文件列表](#文件列表)
4. [文件下载](#文件下载)
5. [文件删除](#文件删除)
6. [存储统计](#存储统计)
7. [完整示例](#完整示例)

---

## 🔐 认证

### 登录获取 Token

**接口：** `POST /api/auth/login`

```javascript
// 登录
const loginResponse = await fetch('http://your-server:3000/api/auth/login', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    username: 'your_username',
    password: 'your_password'
  })
});

const loginData = await loginResponse.json();
/*
响应格式：
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "user-uuid",
      "username": "your_username"
    }
  }
}
*/

const token = loginData.data.token;

// 保存 token 供后续请求使用
localStorage.setItem('authToken', token);
```

### 注册新用户

**接口：** `POST /api/auth/register`

```javascript
const registerResponse = await fetch('http://your-server:3000/api/auth/register', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    username: 'new_username',
    password: 'secure_password123'
  })
});

const registerData = await registerResponse.json();
// 注册成功后自动登录，响应格式与登录相同
```

---

## 📤 文件上传

### 上传单个文件

**接口：** `POST /api/files/upload`

```javascript
// HTML
<input type="file" id="fileInput" />

// JavaScript
const fileInput = document.getElementById('fileInput');
const file = fileInput.files[0];

const formData = new FormData();
formData.append('file', file);

const token = localStorage.getItem('authToken');

const uploadResponse = await fetch('http://your-server:3000/api/files/upload', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`
  },
  body: formData
});

const uploadData = await uploadResponse.json();
/*
响应格式：
{
  "success": true,
  "data": {
    "id": "file-uuid-123",
    "originalName": "document.pdf",
    "filename": "abc-def-123.pdf",
    "path": "/uploads/user-id/abc-def-123.pdf",
    "size": 1024000,
    "mimetype": "application/pdf",
    "userId": "user-uuid",
    "uploadedAt": "2025-11-23T06:24:47.000Z",
    "cloudUrl": "/user-id/abc-def-123.pdf"  // 如果上传到七牛云
  }
}
*/

console.log('文件已上传:', uploadData.data.id);
```

### 上传多个文件

**接口：** `POST /api/files/upload/multiple`

```javascript
// HTML
<input type="file" id="multipleFileInput" multiple />

// JavaScript
const fileInput = document.getElementById('multipleFileInput');
const files = fileInput.files;

const formData = new FormData();
for (let i = 0; i < files.length; i++) {
  formData.append('files', files[i]);
}

const token = localStorage.getItem('authToken');

const uploadResponse = await fetch('http://your-server:3000/api/files/upload/multiple', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`
  },
  body: formData
});

const uploadData = await uploadResponse.json();
/*
响应格式：
{
  "success": true,
  "data": [
    { "id": "file-1", "originalName": "file1.pdf", ... },
    { "id": "file-2", "originalName": "file2.jpg", ... }
  ]
}
*/

console.log(`成功上传 ${uploadData.data.length} 个文件`);
```

---

## 📋 文件列表

### 获取当前用户的所有文件

**接口：** `GET /api/files`

```javascript
const token = localStorage.getItem('authToken');

const filesResponse = await fetch('http://your-server:3000/api/files', {
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

const filesData = await filesResponse.json();
/*
响应格式：
{
  "success": true,
  "data": [
    {
      "id": "file-uuid-1",
      "originalName": "report.pdf",
      "filename": "abc-123.pdf",
      "path": "/uploads/user-id/abc-123.pdf",
      "size": 2048000,
      "mimetype": "application/pdf",
      "userId": "user-uuid",
      "uploadedAt": "2025-11-23T06:24:47.000Z",
      "cloudUrl": "/user-id/abc-123.pdf"
    },
    {
      "id": "file-uuid-2",
      "originalName": "photo.jpg",
      "filename": "def-456.jpg",
      "path": "/uploads/user-id/def-456.jpg",
      "size": 512000,
      "mimetype": "image/jpeg",
      "userId": "user-uuid",
      "uploadedAt": "2025-11-23T07:30:00.000Z",
      "cloudUrl": "/user-id/def-456.jpg"
    }
  ]
}
*/

const files = filesData.data;
console.log(`共有 ${files.length} 个文件`);

// 显示文件列表
files.forEach(file => {
  console.log(`- ${file.originalName} (${formatSize(file.size)})`);
});

// 辅助函数：格式化文件大小
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}
```

### React 示例：文件列表组件

```jsx
import React, { useState, useEffect } from 'react';

function FileList() {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchFiles();
  }, []);

  const fetchFiles = async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('authToken');
      
      const response = await fetch('http://your-server:3000/api/files', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      const data = await response.json();
      
      if (data.success) {
        setFiles(data.data);
      } else {
        setError(data.error);
      }
    } catch (err) {
      setError('获取文件列表失败');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleString('zh-CN');
  };

  const formatSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  };

  if (loading) return <div>加载中...</div>;
  if (error) return <div>错误: {error}</div>;

  return (
    <div>
      <h2>我的文件 ({files.length})</h2>
      {files.length === 0 ? (
        <p>暂无文件</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>文件名</th>
              <th>大小</th>
              <th>类型</th>
              <th>上传时间</th>
              <th>存储位置</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {files.map(file => (
              <tr key={file.id}>
                <td>{file.originalName}</td>
                <td>{formatSize(file.size)}</td>
                <td>{file.mimetype}</td>
                <td>{formatDate(file.uploadedAt)}</td>
                <td>{file.cloudUrl ? '本地+云端' : '仅本地'}</td>
                <td>
                  <button onClick={() => downloadFile(file.id)}>下载</button>
                  <button onClick={() => deleteFile(file.id)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default FileList;
```

---

## 📥 文件下载

### 下载文件

**接口：** `GET /api/files/:fileId`

```javascript
// 方式1：浏览器直接下载
function downloadFile(fileId) {
  const token = localStorage.getItem('authToken');
  const downloadUrl = `http://your-server:3000/api/files/${fileId}?token=${token}`;
  
  // 打开下载链接
  window.open(downloadUrl);
}

// 方式2：通过 Fetch API 获取文件
async function downloadFileAsBlob(fileId, fileName) {
  const token = localStorage.getItem('authToken');
  
  const response = await fetch(`http://your-server:3000/api/files/${fileId}`, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error('下载失败');
  }

  // 获取文件内容
  const blob = await response.blob();
  
  // 创建下载链接
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  
  // 清理
  window.URL.revokeObjectURL(url);
  document.body.removeChild(a);
}

// 方式3：显示图片预览
async function previewImage(fileId) {
  const token = localStorage.getItem('authToken');
  
  const response = await fetch(`http://your-server:3000/api/files/${fileId}`, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  const blob = await response.blob();
  const imageUrl = URL.createObjectURL(blob);
  
  // 显示在 img 标签中
  document.getElementById('preview').src = imageUrl;
}
```

### React 示例：文件下载按钮

```jsx
function DownloadButton({ fileId, fileName }) {
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    try {
      setDownloading(true);
      const token = localStorage.getItem('authToken');
      
      const response = await fetch(`http://your-server:3000/api/files/${fileId}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        throw new Error('下载失败');
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      console.log('下载完成');
    } catch (error) {
      console.error('下载失败:', error);
      alert('下载失败');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <button onClick={handleDownload} disabled={downloading}>
      {downloading ? '下载中...' : '下载'}
    </button>
  );
}
```

---

## 🗑️ 文件删除

### 删除文件

**接口：** `DELETE /api/files/:fileId`

```javascript
async function deleteFile(fileId) {
  const token = localStorage.getItem('authToken');
  
  // 确认删除
  if (!confirm('确定要删除这个文件吗？')) {
    return;
  }

  const response = await fetch(`http://your-server:3000/api/files/${fileId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  const data = await response.json();
  
  if (data.success) {
    console.log('文件已删除');
    // 刷新文件列表
    fetchFiles();
  } else {
    console.error('删除失败:', data.error);
    alert('删除失败');
  }
}
```

---

## 📊 存储统计

### 获取存储使用情况

**接口：** `GET /api/files/usage/stats`

```javascript
async function getStorageStats() {
  const token = localStorage.getItem('authToken');
  
  const response = await fetch('http://your-server:3000/api/files/usage/stats', {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  const data = await response.json();
  /*
  响应格式：
  {
    "success": true,
    "data": {
      "totalFiles": 15,
      "totalSize": 52428800,
      "sizeFormatted": "50.00 MB"
    }
  }
  */

  console.log(`文件数量: ${data.data.totalFiles}`);
  console.log(`总大小: ${data.data.sizeFormatted}`);
  
  return data.data;
}
```

---

## 🎯 完整示例

### 完整的文件管理页面

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>文件管理</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }
    .auth-section, .upload-section, .files-section {
      margin-bottom: 30px;
      padding: 20px;
      border: 1px solid #ddd;
      border-radius: 5px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      padding: 10px;
      text-align: left;
      border-bottom: 1px solid #ddd;
    }
    button {
      margin-right: 5px;
      padding: 5px 10px;
      cursor: pointer;
    }
    .stats {
      background: #f0f0f0;
      padding: 10px;
      border-radius: 5px;
    }
  </style>
</head>
<body>
  <!-- 认证区域 -->
  <div class="auth-section" id="authSection">
    <h2>登录</h2>
    <input type="text" id="username" placeholder="用户名" />
    <input type="password" id="password" placeholder="密码" />
    <button onclick="login()">登录</button>
    <button onclick="register()">注册</button>
  </div>

  <!-- 上传区域 -->
  <div class="upload-section" id="uploadSection" style="display: none;">
    <h2>上传文件</h2>
    <input type="file" id="fileInput" multiple />
    <button onclick="uploadFiles()">上传</button>
    <div id="uploadProgress"></div>
  </div>

  <!-- 存储统计 -->
  <div class="stats" id="statsSection" style="display: none;">
    <h3>存储使用情况</h3>
    <p>文件数量: <span id="fileCount">0</span></p>
    <p>总大小: <span id="totalSize">0 B</span></p>
  </div>

  <!-- 文件列表 -->
  <div class="files-section" id="filesSection" style="display: none;">
    <h2>我的文件</h2>
    <button onclick="refreshFiles()">刷新</button>
    <table>
      <thead>
        <tr>
          <th>文件名</th>
          <th>大小</th>
          <th>类型</th>
          <th>上传时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody id="filesList"></tbody>
    </table>
  </div>

  <script>
    const API_BASE = 'http://localhost:3000/api';
    let authToken = localStorage.getItem('authToken');

    // 初始化
    if (authToken) {
      showMainSections();
      refreshFiles();
      loadStats();
    }

    // 登录
    async function login() {
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;

      try {
        const response = await fetch(`${API_BASE}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        const data = await response.json();
        if (data.success) {
          authToken = data.data.token;
          localStorage.setItem('authToken', authToken);
          alert('登录成功');
          showMainSections();
          refreshFiles();
          loadStats();
        } else {
          alert('登录失败: ' + data.error);
        }
      } catch (error) {
        alert('登录出错: ' + error.message);
      }
    }

    // 注册
    async function register() {
      const username = document.getElementById('username').value;
      const password = document.getElementById('password').value;

      try {
        const response = await fetch(`${API_BASE}/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        const data = await response.json();
        if (data.success) {
          authToken = data.data.token;
          localStorage.setItem('authToken', authToken);
          alert('注册成功');
          showMainSections();
          refreshFiles();
        } else {
          alert('注册失败: ' + data.error);
        }
      } catch (error) {
        alert('注册出错: ' + error.message);
      }
    }

    // 显示主要区域
    function showMainSections() {
      document.getElementById('authSection').style.display = 'none';
      document.getElementById('uploadSection').style.display = 'block';
      document.getElementById('filesSection').style.display = 'block';
      document.getElementById('statsSection').style.display = 'block';
    }

    // 上传文件
    async function uploadFiles() {
      const fileInput = document.getElementById('fileInput');
      const files = fileInput.files;

      if (files.length === 0) {
        alert('请选择文件');
        return;
      }

      const formData = new FormData();
      if (files.length === 1) {
        formData.append('file', files[0]);
      } else {
        for (let file of files) {
          formData.append('files', file);
        }
      }

      const endpoint = files.length === 1 ? '/files/upload' : '/files/upload/multiple';

      try {
        document.getElementById('uploadProgress').textContent = '上传中...';
        
        const response = await fetch(`${API_BASE}${endpoint}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${authToken}` },
          body: formData
        });

        const data = await response.json();
        if (data.success) {
          alert('上传成功');
          fileInput.value = '';
          refreshFiles();
          loadStats();
        } else {
          alert('上传失败: ' + data.error);
        }
      } catch (error) {
        alert('上传出错: ' + error.message);
      } finally {
        document.getElementById('uploadProgress').textContent = '';
      }
    }

    // 刷新文件列表
    async function refreshFiles() {
      try {
        const response = await fetch(`${API_BASE}/files`, {
          headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const data = await response.json();
        if (data.success) {
          displayFiles(data.data);
        }
      } catch (error) {
        console.error('获取文件列表失败:', error);
      }
    }

    // 显示文件列表
    function displayFiles(files) {
      const tbody = document.getElementById('filesList');
      tbody.innerHTML = '';

      files.forEach(file => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${file.originalName}</td>
          <td>${formatSize(file.size)}</td>
          <td>${file.mimetype}</td>
          <td>${new Date(file.uploadedAt).toLocaleString('zh-CN')}</td>
          <td>
            <button onclick="downloadFile('${file.id}', '${file.originalName}')">下载</button>
            <button onclick="deleteFile('${file.id}')">删除</button>
          </td>
        `;
        tbody.appendChild(tr);
      });
    }

    // 下载文件
    async function downloadFile(fileId, fileName) {
      try {
        const response = await fetch(`${API_BASE}/files/${fileId}`, {
          headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
      } catch (error) {
        alert('下载失败: ' + error.message);
      }
    }

    // 删除文件
    async function deleteFile(fileId) {
      if (!confirm('确定要删除这个文件吗？')) {
        return;
      }

      try {
        const response = await fetch(`${API_BASE}/files/${fileId}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const data = await response.json();
        if (data.success) {
          alert('删除成功');
          refreshFiles();
          loadStats();
        } else {
          alert('删除失败: ' + data.error);
        }
      } catch (error) {
        alert('删除出错: ' + error.message);
      }
    }

    // 加载存储统计
    async function loadStats() {
      try {
        const response = await fetch(`${API_BASE}/files/usage/stats`, {
          headers: { 'Authorization': `Bearer ${authToken}` }
        });

        const data = await response.json();
        if (data.success) {
          document.getElementById('fileCount').textContent = data.data.totalFiles;
          document.getElementById('totalSize').textContent = data.data.sizeFormatted;
        }
      } catch (error) {
        console.error('获取统计失败:', error);
      }
    }

    // 格式化文件大小
    function formatSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
      if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
      return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    }
  </script>
</body>
</html>
```

---

## 📌 重要提示

### 1. Token 管理
- Token 需要在每个请求的 `Authorization` header 中携带
- 格式：`Bearer <token>`
- 建议使用 `localStorage` 存储 token
- Token 过期后需要重新登录

### 2. 错误处理
所有 API 响应格式统一：
```json
{
  "success": true/false,
  "data": {},        // 成功时的数据
  "error": "..."     // 失败时的错误信息
}
```

### 3. CORS 配置
如果客户端和服务器不在同一域名，需要配置 CORS：
```env
CORS_ORIGIN=http://your-frontend-domain.com
```

### 4. 文件大小限制
默认最大文件大小：100MB
可在 `.env` 中配置：
```env
MAX_FILE_SIZE=104857600  # 字节
```

---

## 🔗 API 端点总览

| 方法 | 端点 | 说明 | 认证 |
|------|------|------|------|
| POST | `/api/auth/register` | 注册新用户 | ❌ |
| POST | `/api/auth/login` | 用户登录 | ❌ |
| POST | `/api/files/upload` | 上传单个文件 | ✅ |
| POST | `/api/files/upload/multiple` | 上传多个文件 | ✅ |
| GET | `/api/files` | 获取文件列表 | ✅ |
| GET | `/api/files/:fileId` | 下载文件 | ✅ |
| DELETE | `/api/files/:fileId` | 删除文件 | ✅ |
| GET | `/api/files/usage/stats` | 存储统计 | ✅ |

---

**更多文档：**
- [七牛云代理功能](./QINIU_PROXY.md)
- [七牛云配置指南](./QINIU_SETUP.md)
- [快速开始](./QUICKSTART.md)
