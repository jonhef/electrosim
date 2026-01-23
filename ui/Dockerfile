# build stage
FROM node:20-alpine AS build
WORKDIR /app

ARG VITE_ENGINE_URL=http://localhost:5000
ENV VITE_ENGINE_URL=${VITE_ENGINE_URL}

COPY package*.json ./
RUN npm ci

COPY . .
RUN VITE_ENGINE_URL=$VITE_ENGINE_URL npm run build

# runtime stage
FROM nginx:1.27-alpine AS final
WORKDIR /usr/share/nginx/html

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist ./

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
