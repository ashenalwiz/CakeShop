require('dotenv').config(); // Load environment variables from .env

require("reflect-metadata");
const express = require("express");
const { DataSource, EntitySchema } = require("typeorm");
const { Client } = require("pg");
const fs = require("fs");
const path = require("path");

const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse JSON and URL-encoded bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint for AWS Load Balancer
app.get("/health", (req, res) => {
  res.status(200).json({ status: "OK", timestamp: new Date().toISOString() });
});

// Define the Product entity with a new "image" field.
const ProductEntity = new EntitySchema({
  name: "Product",
  tableName: "products",
  columns: {
    id: { primary: true, type: "int", generated: true },
    name: { type: "varchar", nullable: false },
    price: { type: "float", nullable: false },
    image: { type: "varchar", nullable: false }
  }
});

// Define the Order entity
const OrderEntity = new EntitySchema({
  name: "Order",
  tableName: "orders",
  columns: {
    id: { primary: true, type: "int", generated: true },
    name: { type: "varchar", nullable: false },
    address: { type: "varchar", nullable: false },
    total: { type: "float", nullable: false },
    createdAt: { type: "timestamp", createDate: true }
  },
  relations: {
    orderItems: {
      type: "one-to-many",
      target: "OrderItem",
      inverseSide: "order",
      cascade: true
    }
  }
});

// Define the OrderItem entity
const OrderItemEntity = new EntitySchema({
  name: "OrderItem",
  tableName: "order_items",
  columns: {
    id: { primary: true, type: "int", generated: true },
    productName: { type: "varchar", nullable: false },
    productPrice: { type: "float", nullable: false },
    quantity: { type: "int", nullable: false, default: 1 }
  },
  relations: {
    order: {
      type: "many-to-one",
      target: "Order",
      joinColumn: true,
      onDelete: "CASCADE"
    }
  }
});

// Function to ensure the target database exists; if not, create it.
async function ensureDatabaseExists() {
  const targetDB = process.env.DB_NAME || "sweet_treats_bakery";
  const dbConfig = {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 5432,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: "postgres" // Connect to the default database first
  };

  // Add SSL configuration for AWS RDS
  if (process.env.DB_HOST && !process.env.DB_HOST.includes('localhost')) {
    dbConfig.ssl = {
      rejectUnauthorized: false // AWS RDS requires SSL but we'll use flexible SSL
    };
  }

  const client = new Client(dbConfig);
  
  try {
    await client.connect();
    console.log("Connected to PostgreSQL server");

    const result = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [targetDB]);
    if (result.rowCount === 0) {
      await client.query(`CREATE DATABASE "${targetDB}"`);
      console.log(`Database "${targetDB}" created.`);
    } else {
      console.log(`Database "${targetDB}" already exists.`);
    }
    await client.end();
  } catch (error) {
    console.error("Error ensuring database exists:", error);
    // Don't throw error, let TypeORM handle connection
  }
}

// Function to upload all files from the "static" folder to S3 using AWS SDK v3.
function uploadStaticFilesToS3() {
  return new Promise((resolve, reject) => {
    if (!process.env.S3_BUCKET) {
      console.log("S3_BUCKET not set; skipping static file upload.");
      return resolve();
    }

    if (!process.env.S3_REGION) {
      console.log("S3_REGION not set; skipping static file upload.");
      return resolve();
    }

    // Import S3Client and Upload from AWS SDK v3 modules
    const { S3Client } = require("@aws-sdk/client-s3");
    const { Upload } = require("@aws-sdk/lib-storage");

    // Create S3 client with credentials from environment variables or IAM role
    const s3ClientConfig = {
      region: process.env.S3_REGION
    };

    // Only add credentials if they are provided (for local dev)
    // In EC2, IAM roles will be used automatically
    if (process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY) {
      s3ClientConfig.credentials = {
        accessKeyId: process.env.S3_ACCESS_KEY,
        secretAccessKey: process.env.S3_SECRET_KEY
      };
    }

    const s3Client = new S3Client(s3ClientConfig);

    const staticFolder = path.join(__dirname, "static");
    if (!fs.existsSync(staticFolder)) {
      console.log("Static folder does not exist; skipping S3 upload.");
      return resolve();
    }

    fs.readdir(staticFolder, (err, files) => {
      if (err) {
        console.error("Error reading static folder:", err);
        return reject(err);
      }
      
      if (files.length === 0) {
        console.log("No files in static folder; skipping S3 upload.");
        return resolve();
      }

      const uploadPromises = files.map(async (file) => {
        const filePath = path.join(staticFolder, file);
        const fileStream = fs.createReadStream(filePath);
        const uploadParams = {
          Bucket: process.env.S3_BUCKET,
          Key: file,
          Body: fileStream,
          ContentType: getContentType(file)
        };
        
        try {
          const parallelUpload = new Upload({
            client: s3Client,
            params: uploadParams
          });
          const data = await parallelUpload.done();
          console.log(`Uploaded ${file} to ${data.Location}`);
        } catch (err) {
          console.error(`Error uploading ${file}:`, err);
          throw err;
        }
      });
      
      Promise.all(uploadPromises)
        .then(() => {
          console.log("All static files uploaded successfully.");
          resolve();
        })
        .catch(reject);
    });
  });
}

// Helper function to determine content type
function getContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const contentTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.html': 'text/html'
  };
  return contentTypes[ext] || 'application/octet-stream';
}

// Configure the data source for PostgreSQL using TypeORM
const AppDataSource = new DataSource({
  type: "postgres",
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 5432,
  username: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME || "sweet_treats_bakery",
  synchronize: true, // Set to false in production after initial setup
  logging: process.env.NODE_ENV === 'development',
  entities: [ProductEntity, OrderEntity, OrderItemEntity],
  ssl: process.env.DB_HOST && !process.env.DB_HOST.includes('localhost') ? {
    rejectUnauthorized: false
  } : false
});

// Helper function to render a full HTML page with Bootstrap, Font Awesome, and animation CSS.
function renderPage(title, content) {
  return `
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
      <title>${title}</title>
      <link rel="stylesheet" href="https://stackpath.bootstrapcdn.com/bootstrap/4.5.2/css/bootstrap.min.css">
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">
      <style>
        body { 
          padding-top: 50px; 
          background: linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%);
          min-height: 100vh;
        }
        .container { max-width: 800px; }
        .hero-banner {
          border-radius: 15px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.3);
          overflow: hidden;
        }
        .product-card {
          border-radius: 15px;
          box-shadow: 0 5px 15px rgba(0,0,0,0.1);
          transition: transform 0.3s ease;
        }
        .product-card:hover {
          transform: translateY(-5px);
        }
        .btn {
          border-radius: 25px;
          padding: 10px 30px;
          font-weight: bold;
        }
        .btn-success {
          background: linear-gradient(45deg, #56ab2f, #a8e6cf);
          border: none;
        }
        .btn-primary {
          background: linear-gradient(45deg, #667eea, #764ba2);
          border: none;
        }
        /* Fireworks animation styles */
        .fireworks-container {
          position: absolute;
          pointer-events: none;
        }
        .firework {
          position: absolute;
          width: 8px;
          height: 8px;
          background: gold;
          border-radius: 50%;
          opacity: 1;
          animation: firework-animation 0.8s ease-out forwards;
        }
        @keyframes firework-animation {
          0% { transform: translate(0, 0); opacity: 1; }
          100% { transform: translate(var(--dx), var(--dy)); opacity: 0; }
        }
        .footer {
          margin-top: 50px;
          padding: 20px 0;
          background-color: rgba(255,255,255,0.1);
          border-radius: 10px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        ${content}
        <div class="footer text-center text-muted">
          <small>Hosted on AWS EC2 • Images stored on S3 • Data on RDS PostgreSQL</small>
        </div>
      </div>
      <script src="https://code.jquery.com/jquery-3.5.1.slim.min.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/popper.js@1.16.1/dist/umd/popper.min.js"></script>
      <script src="https://stackpath.bootstrapcdn.com/bootstrap/4.5.2/js/bootstrap.min.js"></script>
    </body>
  </html>
  `;
}

// Construct the hero image URL using AWS S3 environment variables.
const heroImageUrl = process.env.S3_BUCKET && process.env.S3_REGION ? 
  `https://${process.env.S3_BUCKET}.s3.${process.env.S3_REGION}.amazonaws.com/bakery.jpg` :
  'https://via.placeholder.com/800x400/ff6b6b/ffffff?text=Sweet+Treats+Bakery';

// Home route with a hero banner image from AWS S3.
app.get("/", (req, res) => {
  const content = `
    <div class="hero-banner" style="
      position: relative;
      background: url('${heroImageUrl}') no-repeat center center;
      background-size: cover;
      height: 500px;
    ">
      <div style="
        position: absolute;
        top: 0; left: 0;
        width: 100%; height: 100%;
        background: rgba(0,0,0,0.5);
      ">
        <div class="d-flex h-100 align-items-center justify-content-center">
          <div class="text-center text-white">
            <h1 class="display-3">🍰 Sweet Treats Bakery 🍰</h1>
            <p class="lead">Delicious cakes made with love and the finest ingredients.</p>
            <p class="small">Now powered by AWS Cloud Services!</p>
            <a class="btn btn-primary btn-lg" href="/products" role="button">
              <i class="fas fa-birthday-cake"></i> View Our Cakes
            </a>
          </div>
        </div>
      </div>
    </div>
    <div class="mt-5">
      <div class="row text-center">
        <div class="col-md-4 mb-4">
          <div class="card product-card border-0">
            <div class="card-body">
              <i class="fas fa-birthday-cake fa-3x text-primary mb-3"></i>
              <h5 class="card-title">Fresh Daily</h5>
              <p class="card-text">All our cakes are baked fresh every morning with premium ingredients.</p>
            </div>
          </div>
        </div>
        <div class="col-md-4 mb-4">
          <div class="card product-card border-0">
            <div class="card-body">
              <i class="fas fa-heart fa-3x text-danger mb-3"></i>
              <h5 class="card-title">Made with Love</h5>
              <p class="card-text">Each cake is crafted with passion and attention to detail.</p>
            </div>
          </div>
        </div>
        <div class="col-md-4 mb-4">
          <div class="card product-card border-0">
            <div class="card-body">
              <i class="fas fa-truck fa-3x text-success mb-3"></i>
              <h5 class="card-title">Fast Delivery</h5>
              <p class="card-text">Quick and reliable delivery to your doorstep.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  res.send(renderPage("Sweet Treats Bakery", content));
});

// Products route: List available products from the database with images.
app.get("/products", async (req, res) => {
  try {
    const productRepository = AppDataSource.getRepository("Product");
    const products = await productRepository.find();

    // Header with a shopping cart icon and a "Cart" button.
    let html = `
      <div class="d-flex justify-content-between align-items-center mb-4">
        <h1 class="mb-0"><i class="fas fa-birthday-cake text-primary"></i> Our Delicious Cakes</h1>
        <button class="btn btn-secondary" onclick="location.href='/cart'" id="cartButton">
          <span id="cartIcon"><i class="fas fa-shopping-cart"></i></span> Cart (<span id="cartCount">0</span>)
        </button>
      </div>
      <div class="row">
    `;

    products.forEach(product => {
      // Construct the product image URL using S3 environment variables.
      const imageUrl = process.env.S3_BUCKET && process.env.S3_REGION ? 
        `https://${process.env.S3_BUCKET}.s3.${process.env.S3_REGION}.amazonaws.com/${product.image}` :
        `https://via.placeholder.com/300x300/ff6b6b/ffffff?text=${encodeURIComponent(product.name)}`;
        
      html += `
        <div class="col-md-6 mb-4">
          <div class="card product-card border-0 h-100">
            <img src="${imageUrl}" alt="${product.name}" class="card-img-top" style="height:300px; object-fit:cover;" onerror="this.src='https://via.placeholder.com/300x300/ff6b6b/ffffff?text=${encodeURIComponent(product.name)}'" />
            <div class="card-body d-flex flex-column">
              <h5 class="card-title text-center">${product.name}</h5>
              <p class="card-text text-center text-muted mb-3">Premium quality cake</p>
              <div class="mt-auto">
                <div class="d-flex justify-content-between align-items-center">
                  <span class="h4 text-success mb-0">$${product.price.toFixed(2)}</span>
                  <button class="btn btn-success" onclick="addToCart(${product.id}, '${product.name}', ${product.price})">
                    <i class="fas fa-cart-plus"></i> Add to Cart
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>`;
    });
    html += `</div>
      <!-- Button at the bottom to go to the shopping cart -->
      <div class="text-center mt-4">
        <button class="btn btn-primary btn-lg" onclick="location.href='/cart'">
          <i class="fas fa-shopping-cart"></i> Go to Cart
        </button>
      </div>
      <script>
        function addToCart(id, name, price) {
          let cart = sessionStorage.getItem('cart');
          cart = cart ? JSON.parse(cart) : [];
          const existingItem = cart.find(item => item.id === id);
          if (existingItem) {
            existingItem.quantity += 1;
          } else {
            cart.push({ id, name, price, quantity: 1 });
          }
          sessionStorage.setItem('cart', JSON.stringify(cart));
          updateCartCount();
          showFireworks();
        }

        function updateCartCount() {
          let cart = sessionStorage.getItem('cart');
          cart = cart ? JSON.parse(cart) : [];
          const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
          document.getElementById('cartCount').innerText = totalItems;
        }
        
        // Function to create a fireworks effect around the cart button.
        function showFireworks() {
          const cartButton = document.getElementById('cartButton');
          const rect = cartButton.getBoundingClientRect();
          // Create a container for fireworks positioned over the button.
          const container = document.createElement('div');
          container.className = 'fireworks-container';
          container.style.left = rect.left + 'px';
          container.style.top = rect.top + 'px';
          container.style.width = rect.width + 'px';
          container.style.height = rect.height + 'px';
          document.body.appendChild(container);
          
          // Create multiple sparkles.
          for (let i = 0; i < 15; i++) {
            const sparkle = document.createElement('div');
            sparkle.className = 'firework';
            // Random colors for cake celebration
            const colors = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', '#f0932b'];
            sparkle.style.background = colors[Math.floor(Math.random() * colors.length)];
            // Random angle and distance.
            const angle = Math.random() * 2 * Math.PI;
            const distance = Math.random() * 40 + 20;
            const dx = Math.cos(angle) * distance;
            const dy = Math.sin(angle) * distance;
            sparkle.style.setProperty('--dx', dx + 'px');
            sparkle.style.setProperty('--dy', dy + 'px');
            container.appendChild(sparkle);
          }
          // Remove the container after the animation completes.
          setTimeout(() => {
            container.remove();
          }, 1000);
        }

        document.addEventListener('DOMContentLoaded', updateCartCount);
      </script>
    `;
    res.send(renderPage("Our Cakes - Sweet Treats Bakery", html));
  } catch (error) {
    console.error("Error fetching products:", error);
    res.status(500).send("Error fetching products");
  }
});

// Cart route: Display current cart items from sessionStorage.
app.get("/cart", (req, res) => {
  const content = `
    <div class="text-center mb-4">
      <h1><i class="fas fa-shopping-cart text-primary"></i> Your Cart</h1>
    </div>
    <div id="cartContainer"></div>
    <div class="text-center mt-4">
      <a class="btn btn-success btn-lg" href="/checkout">
        <i class="fas fa-credit-card"></i> Proceed to Checkout
      </a>
      <a class="btn btn-secondary btn-lg ml-3" href="/products">
        <i class="fas fa-arrow-left"></i> Continue Shopping
      </a>
    </div>
    <script>
      function renderCart() {
        let cart = sessionStorage.getItem('cart');
        let container = document.getElementById('cartContainer');
        if (!cart || JSON.parse(cart).length === 0) {
          container.innerHTML = '<div class="text-center"><div class="card"><div class="card-body"><i class="fas fa-shopping-cart fa-3x text-muted mb-3"></i><h4>Your cart is empty</h4><p class="text-muted">Add some delicious cakes to get started!</p></div></div></div>';
          return;
        }
        cart = JSON.parse(cart);
        let html = '<div class="card"><div class="card-body">';
        let total = 0;
        cart.forEach(item => {
          const itemTotal = item.price * item.quantity;
          total += itemTotal;
          html += '<div class="d-flex justify-content-between align-items-center border-bottom py-3">' +
                    '<div><h6 class="mb-0">' + item.name + '</h6><small class="text-muted">$' + item.price.toFixed(2) + ' each</small></div>' +
                    '<div class="text-right"><span class="badge badge-primary">' + item.quantity + 'x</span><br>' +
                    '<strong>$' + itemTotal.toFixed(2) + '</strong></div>' +
                  '</div>';
        });
        html += '<div class="pt-3"><h4 class="text-right">Total: <span class="text-success">$' + total.toFixed(2) + '</span></h4></div>';
        html += '</div></div>';
        container.innerHTML = html;
      }
      document.addEventListener('DOMContentLoaded', renderCart);
    </script>
  `;
  res.send(renderPage("Your Cart - Sweet Treats Bakery", content));
});

// Checkout page: Show order form and populate cart details from sessionStorage.
app.get("/checkout", (req, res) => {
  const content = `
    <div class="text-center mb-4">
      <h1><i class="fas fa-credit-card text-success"></i> Checkout</h1>
    </div>
    <div class="row">
      <div class="col-md-6">
        <div class="card">
          <div class="card-header">
            <h5><i class="fas fa-list"></i> Order Summary</h5>
          </div>
          <div class="card-body">
            <div id="cartSummary"></div>
          </div>
        </div>
      </div>
      <div class="col-md-6">
        <div class="card">
          <div class="card-header">
            <h5><i class="fas fa-user"></i> Delivery Information</h5>
          </div>
          <div class="card-body">
            <form method="POST" action="/checkout" onsubmit="return prepareOrder()">
              <div class="form-group">
                <label for="name"><i class="fas fa-user"></i> Full Name:</label>
                <input type="text" class="form-control" id="name" name="name" required placeholder="Enter your full name">
              </div>
              <div class="form-group">
                <label for="address"><i class="fas fa-map-marker-alt"></i> Delivery Address:</label>
                <textarea class="form-control" id="address" name="address" rows="4" required placeholder="Enter your complete delivery address"></textarea>
              </div>
              <input type="hidden" id="cartData" name="cartData">
              <button type="submit" class="btn btn-success btn-lg btn-block">
                <i class="fas fa-check"></i> Place Order
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
    <script>
      function renderCartSummary() {
        let cart = sessionStorage.getItem('cart');
        let summary = document.getElementById('cartSummary');
        if (!cart || JSON.parse(cart).length === 0) {
          summary.innerHTML = '<p class="text-center text-muted">Your cart is empty.</p>';
          return;
        }
        cart = JSON.parse(cart);
        let html = '';
        let total = 0;
        cart.forEach(item => {
          const itemTotal = item.price * item.quantity;
          total += itemTotal;
          html += '<div class="d-flex justify-content-between border-bottom py-2">' +
                    '<span>' + item.name + ' x' + item.quantity + '</span>' +
                    '<span>$' + itemTotal.toFixed(2) + '</span>' +
                  '</div>';
        });
        html += '<div class="d-flex justify-content-between pt-2"><strong>Total: </strong><strong class="text-success">$' + total.toFixed(2) + '</strong></div>';
        summary.innerHTML = html;
      }
      
      function prepareOrder() {
        let cart = sessionStorage.getItem('cart');
        if (!cart || JSON.parse(cart).length === 0) {
          alert('Your cart is empty!');
          return false;
        }
        document.getElementById('cartData').value = cart;
        return true;
      }
      
      document.addEventListener('DOMContentLoaded', renderCartSummary);
    </script>
  `;
  res.send(renderPage("Checkout - Sweet Treats Bakery", content));
});

// Process checkout: Save the order and order items to the database using submitted cart data.
app.post("/checkout", async (req, res) => {
  const { name, address, cartData } = req.body;
  let cartItems;
  try {
    cartItems = JSON.parse(cartData);
  } catch (error) {
    return res.status(400).send("Invalid cart data");
  }
  const total = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
  
  try {
    const orderRepository = AppDataSource.getRepository("Order");
    const order = {
      name,
      address,
      total,
      orderItems: cartItems.map(item => ({
        productName: item.name,
        productPrice: item.price,
        quantity: item.quantity
      }))
    };
    const savedOrder = await orderRepository.save(order);
    const content = `
      <div class="text-center">
        <div class="card">
          <div class="card-body">
            <i class="fas fa-check-circle fa-5x text-success mb-4"></i>
            <h1 class="text-success">Thank you for your order!</h1>
            <p class="lead">Your order ID is <strong>#${savedOrder.id}</strong></p>
            <p>We appreciate your business! Your delicious cakes will be prepared with care and delivered soon.</p>
            <div class="mt-4">
              <a class="btn btn-primary btn-lg" href="/" onclick="clearCart()">
                <i class="fas fa-home"></i> Back to Home
              </a>
              <a class="btn btn-success btn-lg ml-3" href="/products" onclick="clearCart()">
                <i class="fas fa-birthday-cake"></i> Order More Cakes
              </a>
            </div>
          </div>
        </div>
      </div>
      <script>
        function clearCart() {
          sessionStorage.removeItem('cart');
        }
        clearCart();
      </script>
    `;
    res.send(renderPage("Order Confirmation - Sweet Treats Bakery", content));
  } catch (error) {
    console.error("Error processing order:", error);
    res.status(500).send("Error processing order");
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).send('Something went wrong!');
});

// Graceful shutdown handling
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy();
  }
  process.exit(0);
});

// Initialize the application
async function startApp() {
  try {
    console.log('Starting Sweet Treats Bakery application...');
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Port: ${port}`);
    
    // Ensure database exists
    await ensureDatabaseExists();
    
    // Upload static files to S3
    await uploadStaticFilesToS3();
    
    // Initialize TypeORM
    await AppDataSource.initialize();
    console.log("Database connected successfully!");
    
    // Seed default products if none exist
    const productRepository = AppDataSource.getRepository("Product");
    const count = await productRepository.count();
    if (count === 0) {
      const defaultProducts = [
        { name: "Chocolate Fudge Cake", price: 25.99, image: "chocolate_cake.jpg" },
        { name: "Strawberry Cheesecake", price: 28.50, image: "strawberry_cheesecake.jpg" },
        { name: "Red Velvet Cake", price: 24.75, image: "red_velvet.jpg" },
        { name: "Vanilla Birthday Cake", price: 22.99, image: "vanilla_birthday.jpg" },
        { name: "Lemon Drizzle Cake", price: 21.50, image: "lemon_drizzle.jpg" },
        { name: "Carrot Cake", price: 23.99, image: "carrot_cake.jpg" }
      ];
      for (const prod of defaultProducts) {
        await productRepository.save(prod);
      }
      console.log("Inserted default cake products.");
    }
    
    // Start the server
    app.listen(port, '0.0.0.0', () => {
      console.log(` Sweet Treats Bakery is running!`);
      console.log(` Server: http://0.0.0.0:${port}`);
      console.log(` Health check: http://0.0.0.0:${port}/health`);
      console.log(` Database: ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`);
      console.log(` S3 Bucket: ${process.env.S3_BUCKET || 'Not configured'}`);
    });
    
  } catch (error) {
    console.error(" Error starting application:", error);
    process.exit(1);
  }
}

// Start the application
startApp();