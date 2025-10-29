# Production Setup Guide

## PostgreSQL Configuration

1. **Update Environment Variables**:
   - Replace placeholder values in `.env` or `.env.production`
   - Set your actual PostgreSQL credentials
   - Ensure `DATABASE_CLIENT=postgres`

2. **Required Environment Variables**:
   ```
   DATABASE_CLIENT=postgres
   DATABASE_HOST=your_postgres_host
   DATABASE_PORT=5432
   DATABASE_NAME=your_production_db
   DATABASE_USERNAME=your_db_user
   DATABASE_PASSWORD=your_secure_db_password
   DATABASE_SSL=true
   DATABASE_URL=postgresql://user:password@host:port/database
   ```

## Cloudinary Configuration

1. **Get Cloudinary Credentials**:
   - Sign up at https://cloudinary.com
   - Get your Cloud Name, API Key, and API Secret from the dashboard

2. **Set Environment Variables**:
   ```
   CLOUDINARY_NAME=your_cloudinary_cloud_name
   CLOUDINARY_KEY=your_cloudinary_api_key
   CLOUDINARY_SECRET=your_cloudinary_api_secret
   ```

## Security Notes

- Generate new APP_KEYS, JWT secrets for production
- Use strong database passwords
- Enable SSL for database connections
- Keep environment variables secure and never commit them to version control

## Running in Production

```bash
# Build the application
npm run build

# Start in production mode
NODE_ENV=production npm start
```