const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

// Load environment variables
dotenv.config();

// Create Express app
const app = express();
const PORT = process.env.PORT || 8001;

// Create uploads directory if it doesn't exist (for local fallback)
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));
app.use('/uploads', express.static(uploadsDir));

// Import initialization functions
const { initializeStorage } = require('./dist/services/blobStorageService');
const { initializeCosmosDb } = require('./dist/config/cosmosDbSetup');

// Track initialization status
let blobStorageInitialized = false;

// Serve frontend static files if in production
if (process.env.NODE_ENV === 'production') {
  const frontendBuildPath = path.join(__dirname, '../frontend/build');
  if (fs.existsSync(frontendBuildPath)) {
    console.log('Serving frontend static files from:', frontendBuildPath);
    app.use(express.static(frontendBuildPath));
    
    // Handle client-side routing
    app.get('*', (req, res) => {
      // Don't redirect API or file requests
      if (req.url.startsWith('/api') || 
          req.url.startsWith('/uploads') || 
          req.url.includes('.')) {
        return res.status(404).send('Not found');
      }
      
      res.sendFile(path.join(frontendBuildPath, 'index.html'));
    });
  } else {
    console.warn('Frontend build directory not found. API-only mode active.');
  }
}

// Initialize server resources and start listening
async function startServer() {
  console.log('Starting server initialization...');
  
  // Initialize Azure Blob Storage
  try {
    await initializeStorage();
    console.log('Azure Blob Storage initialized successfully');
    blobStorageInitialized = true;
  } catch (error) {
    console.error('Error initializing Azure Blob Storage:', error);
    console.warn('Will use local file system for storage as fallback');
  }
  
  // Initialize Cosmos DB
  try {
    await initializeCosmosDb();
    console.log('Cosmos DB initialized successfully');
  } catch (error) {
    console.error('Error initializing Cosmos DB:', error);
    console.warn('User registration and login may not work');
  }
  
  // Import routes
  try {
    const { fileRoutes } = require('./dist/routes/fileRoutes');
    const { authRoutes } = require('./dist/routes/authRoutes');
    
    // Use route modules
    app.use('/api/files', fileRoutes);
    app.use('/api/auth', authRoutes);
    console.log('Successfully loaded routes from TypeScript build');
  } catch (error) {
    console.error('Error loading routes:', error);
    
    // Fallback simple routes in case TypeScript routes fail to load
    app.get('/api/files/list', (req, res) => {
      try {
        const files = fs.readdirSync(uploadsDir)
          .filter(file => !file.startsWith('.'))
          .map(file => {
            const filePath = path.join(uploadsDir, file);
            const stats = fs.statSync(filePath);
            return {
              filename: file,
              size: stats.size,
              createdAt: stats.birthtime
            };
          });
        
        res.status(200).json(files);
      } catch (error) {
        console.error('Error listing files:', error);
        res.status(500).json({ error: 'Failed to list files' });
      }
    });
    
    app.get('/api/files/download/:filename', (req, res) => {
      try {
        const { filename } = req.params;
        const filePath = path.join(uploadsDir, filename);
        
        if (!fs.existsSync(filePath)) {
          return res.status(404).json({ error: 'File not found' });
        }
        
        res.download(filePath);
      } catch (error) {
        console.error('Error downloading file:', error);
        res.status(500).json({ error: 'Failed to download file' });
      }
    });
    
    // Add clear cache route as a fallback
    app.post('/api/files/clear-cache', (req, res) => {
      try {
        console.log(`Clearing cache from directory: ${uploadsDir}`);
        
        // Check if directory exists
        if (!fs.existsSync(uploadsDir)) {
          return res.status(200).json({ message: 'No cache to clear' });
        }
        
        // Get files and directories, excluding hidden files and the test directory
        const files = fs.readdirSync(uploadsDir)
          .filter(file => !file.startsWith('.') && file !== 'test');
        
        // Delete each file
        let deletedCount = 0;
        const errors = [];
        
        for (const file of files) {
          const filePath = path.join(uploadsDir, file);
          try {
            const stats = fs.statSync(filePath);
            
            if (stats.isDirectory()) {
              console.log(`Skipping directory: ${file}`);
              continue;
            }
            
            fs.unlinkSync(filePath);
            console.log(`Deleted file: ${file}`);
            deletedCount++;
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Unknown error';
            console.error(`Error deleting ${file}: ${errorMessage}`);
            errors.push(`${file}: ${errorMessage}`);
          }
        }
        
        if (errors.length > 0) {
          return res.status(207).json({
            message: `Cache partially cleared. ${deletedCount} files deleted, ${errors.length} errors.`,
            deletedCount,
            errors
          });
        }
        
        res.status(200).json({ 
          message: 'Cache cleared successfully', 
          deletedCount 
        });
      } catch (error) {
        console.error('Error clearing cache:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        res.status(500).json({ error: `Failed to clear cache: ${errorMessage}` });
      }
    });
  }
  
  // Health check endpoint
  app.get('/api/health', (req, res) => {
    res.status(200).json({ 
      status: 'ok',
      blobStorage: blobStorageInitialized ? 'connected' : 'fallback'
    });
  });
  
  // Start the server
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

// Start the server
startServer().catch(error => {
  console.error('Failed to start server:', error);
  process.exit(1);
}); 