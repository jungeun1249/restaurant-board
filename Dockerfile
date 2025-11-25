FROM node:20-slim

RUN apt-get update && \ 
    apt-get install -y build-essential python3 git && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./

RUN rm -rf node_modules

RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD [ "npm", "start" ]