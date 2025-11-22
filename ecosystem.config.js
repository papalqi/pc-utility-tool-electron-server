module.exports = {
  apps: [{
    name: 'pc-utility-tool-server',
    script: 'npm',
    args: 'start',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    },
    env_development: {
      NODE_ENV: 'development'
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    // 自动重启配置
    min_uptime: '10s',
    max_restarts: 10,
    // 集群模式（可选，根据需要调整）
    // instances: 'max',
    // exec_mode: 'cluster'
  }]
};
