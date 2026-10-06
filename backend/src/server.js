const app = require('./app');
const { port } = require('./config/env');

app.listen(port, () => {
  console.log(`AK VisionFlow API listening on port ${port}`);
});
