FROM node:20-alpine
WORKDIR /workspace/backend
COPY backend/package*.json ./
RUN npm install
EXPOSE 5000
CMD ["sh", "-c", "npm install && npm run dev"]
