# Jarvis UI Frontend Dockerfile - Multi-stage build
# Stage 1: Build the frontend
FROM node:20-alpine AS builder

WORKDIR /app

# Set production environment for build
ENV NODE_ENV=production

# Copy package files
COPY package*.json ./

# Install dependencies (including devDependencies for build)
RUN npm ci --include=dev

# Copy source code
COPY . .

# Build the application with production base path
RUN npm run build

# Stage 2: Serve with nginx
FROM nginx:alpine

# Install curl for health check
RUN apk add --no-cache curl

# Copy built files to nginx
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Expose the frontend port
EXPOSE 20006

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:20006/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
