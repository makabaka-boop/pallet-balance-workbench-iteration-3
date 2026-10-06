# ---- 构建阶段：编译纯前端静态资源 ----
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run test && npm run build

# ---- 运行阶段：Nginx 托管静态文件，无任何外部网络依赖 ----
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
