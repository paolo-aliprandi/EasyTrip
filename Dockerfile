FROM node:22

# Create app directory
WORKDIR '/app'

# Install app dependencies
#COPY package*.json ./
COPY EasyTrip/package*.json ./

RUN npm install
#RUN npm --prefix ./EasyTrip install ./EasyTrip
# If you are building your code for production
# RUN npm ci --only=production

# Bundle app source
COPY ./EasyTrip .
#COPY . .

EXPOSE 8080

CMD [ "npm", "start" ]
#CMD [ "node", "index.js" ]