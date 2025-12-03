# Serverless AI Image Generation Pipeline

A serverless architecture for generating AI-powered product images using OpenAI, AWS Lambda, SQS, DynamoDB, and S3. This pipeline accepts product URLs, scrapes product information, generates AI images with text overlays, and stores them securely in S3.

## Architecture Overview

The system consists of three Lambda functions working together:

1. **Receiver Lambda** - Accepts image generation requests via HTTP POST
2. **Worker Lambda** - Processes jobs from SQS queue, generates AI images
3. **Responder Lambda** - Returns job status and presigned URLs for generated images

**AWS Services Used:**
- AWS Lambda (Node.js 18.x)
- Amazon SQS (Message Queue)
- Amazon DynamoDB (Job Status Storage)
- Amazon S3 (Image Storage)
- AWS Systems Manager Parameter Store (Configuration)
- Amazon API Gateway (HTTP Endpoints)

---

## Part 1: AWS Services Setup

Before deploying the code, you need to set up the required AWS services and configurations. Follow these steps in order:

### Prerequisites

1. **AWS Account** - You need an active AWS account with appropriate permissions
2. **AWS CLI** - Install and configure AWS CLI on your local machine
3. **Node.js** - Version 18.x or higher
4. **Serverless Framework** - Install globally: `npm install -g serverless`
5. **OpenAI API Key** - Get your API key from [OpenAI Platform](https://platform.openai.com/api-keys)

### Step 1: Configure AWS CLI

1. Install AWS CLI if not already installed:
   ```bash
   # Windows (using PowerShell)
   msiexec.exe /i https://awscli.amazonaws.com/AWSCLIV2.msi
   
   # macOS
   brew install awscli
   
   # Linux
   curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
   unzip awscliv2.zip
   sudo ./aws/install
   ```

2. Configure AWS credentials:
   ```bash
   aws configure
   ```
   Enter your:
   - AWS Access Key ID
   - AWS Secret Access Key
   - Default region (e.g., `us-east-1`)
   - Default output format (e.g., `json`)

3. Verify configuration:
   ```bash
   aws sts get-caller-identity
   ```

### Step 2: Set Up IAM Permissions

Your AWS user/role needs the following permissions:

1. **Go to IAM Console** → Users → Your User → Add Permissions

2. **Attach the following policies:**
   - `AWSLambda_FullAccess`
   - `AmazonS3FullAccess`
   - `AmazonDynamoDBFullAccess`
   - `AmazonSQSFullAccess`
   - `AmazonAPIGatewayAdministrator`
   - `CloudFormationFullAccess`
   - `IAMFullAccess` (or create a custom policy with minimal required permissions)
   - `AmazonSSMFullAccess` (for Parameter Store)

3. **Alternatively, create a custom policy** with minimal permissions:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "lambda:*",
           "s3:*",
           "dynamodb:*",
           "sqs:*",
           "apigateway:*",
           "cloudformation:*",
           "iam:CreateRole",
           "iam:AttachRolePolicy",
           "iam:PutRolePolicy",
           "iam:GetRole",
           "ssm:*",
           "logs:*"
         ],
         "Resource": "*"
       }
     ]
   }
   ```

### Step 3: Create S3 Bucket (Optional - Will be created automatically)

The Serverless Framework will create the S3 bucket automatically during deployment. However, if you want to create it manually:

1. **Go to S3 Console** → Create bucket
2. **Bucket name**: `teadifyz-ai-image-generative-dev` (or your preferred name)
3. **Region**: Choose your deployment region (e.g., `us-east-1`)
4. **Block Public Access**: Keep all settings enabled (default)
5. **Bucket Versioning**: Disabled (default)
6. **Encryption**: Enable server-side encryption (AES256)
7. **Create bucket**

**Note:** The bucket will be created automatically by CloudFormation during deployment, so this step is optional.

### Step 4: Create DynamoDB Table (Optional - Will be created automatically)

The Serverless Framework will create the DynamoDB table automatically. If you want to create it manually:

1. **Go to DynamoDB Console** → Create table
2. **Table name**: `image-generation-jobs-dev`
3. **Partition key**: `jobId` (String)
4. **Table settings**: Use default settings
5. **Capacity mode**: On-demand
6. **Create table**

**Note:** The table will be created automatically by CloudFormation during deployment, so this step is optional.

### Step 5: Create SQS Queue (Optional - Will be created automatically)

The Serverless Framework will create the SQS queue automatically. If you want to create it manually:

1. **Go to SQS Console** → Create queue
2. **Queue type**: Standard
3. **Queue name**: `image-generation-queue-dev`
4. **Configuration**:
   - **Visibility timeout**: 900 seconds (15 minutes - must match Lambda timeout)
   - **Message retention period**: 4 days (345600 seconds)
   - **Receive message wait time**: 20 seconds (long polling)
5. **Dead-letter queue**: Create a DLQ with name `image-generation-dlq-dev`
6. **Create queue**

**Note:** The queue will be created automatically by CloudFormation during deployment, so this step is optional.

### Step 6: Store Configuration in AWS Systems Manager Parameter Store

You need to store sensitive configuration values in AWS Systems Manager Parameter Store (SSM). These parameters will be referenced by your Lambda functions.

1. **Go to AWS Systems Manager Console** → Parameter Store → Create parameter

2. **Create the following parameters:**

   **a. OpenAI API Key:**
   - **Name**: `/teadifyz/open_api_key`
   - **Type**: SecureString
   - **Value**: Your OpenAI API key (e.g., `sk-...`)
   - **Description**: OpenAI API key for image generation
   - Click **Create parameter**

   **b. Queue URL:**
   - **Name**: `/teadifyz/queue_url`
   - **Type**: String
   - **Value**: Will be set after first deployment (see below)
   - **Description**: SQS Queue URL
   - Click **Create parameter**
   - **Note**: You'll update this after the first deployment with the actual queue URL

   **c. DynamoDB Table Name:**
   - **Name**: `/teadifyz/dynamodb_table_name`
   - **Type**: String
   - **Value**: `image-generation-jobs-dev` (or your table name)
   - **Description**: DynamoDB table name for job tracking
   - Click **Create parameter**

   **d. S3 Bucket Name:**
   - **Name**: `/teadifyz/s3bucket_name`
   - **Type**: String
   - **Value**: `teadifyz-ai-image-generative-dev` (or your bucket name)
   - **Description**: S3 bucket name for image storage
   - Click **Create parameter**

   **e. SQS ARN:**
   - **Name**: `/teadifyz/sqs_arn`
   - **Type**: String
   - **Value**: Will be set after first deployment (see below)
   - **Description**: SQS Queue ARN
   - Click **Create parameter**
   - **Note**: You'll update this after the first deployment with the actual queue ARN

3. **Alternative: Create parameters via AWS CLI:**

   ```bash
   # Set OpenAI API Key (replace YOUR_API_KEY with your actual key)
   aws ssm put-parameter \
     --name "/teadifyz/open_api_key" \
     --value "YOUR_API_KEY" \
     --type "SecureString" \
     --description "OpenAI API key for image generation"

   # Set DynamoDB Table Name
   aws ssm put-parameter \
     --name "/teadifyz/dynamodb_table_name" \
     --value "image-generation-jobs-dev" \
     --type "String" \
     --description "DynamoDB table name"

   # Set S3 Bucket Name
   aws ssm put-parameter \
     --name "/teadifyz/s3bucket_name" \
     --value "teadifyz-ai-image-generative-dev" \
     --type "String" \
     --description "S3 bucket name"

   # Queue URL and ARN will be set after first deployment
   ```

### Step 7: Verify AWS Services Setup

Before proceeding to code setup, verify that:

1. ✅ AWS CLI is configured and working
2. ✅ IAM permissions are set correctly
3. ✅ SSM Parameters are created (at minimum: `/teadifyz/open_api_key`)
4. ✅ You have Node.js 18.x installed
5. ✅ Serverless Framework is installed globally

**Test AWS connection:**
```bash
aws sts get-caller-identity
aws ssm get-parameter --name "/teadifyz/open_api_key" --with-decryption
```

---

## Part 2: Code Setup

Now that AWS services are configured, let's set up the code and deploy it.

### Step 1: Navigate to Project Directory

```bash
cd generative-ai-images
```

### Step 2: Install Dependencies

Install all required npm packages:

```bash
npm install
```

This will install:
- AWS SDK v3 clients (DynamoDB, S3, SQS)
- OpenAI SDK
- Axios (for web scraping)
- Cheerio (for HTML parsing)
- Sharp (for image processing)
- Serverless Framework plugins

### Step 3: Configure Environment Variables

The `serverless.yml` file uses environment variables from SSM Parameter Store. Make sure you've created all required parameters (see Part 1, Step 6).

**Key Environment Variables (stored in SSM):**
- `OPENAI_API_KEY` - From `/teadifyz/open_api_key`
- `QUEUE_URL` - From `/teadifyz/queue_url` (set after first deployment)
- `TABLE_NAME` - From `/teadifyz/dynamodb_table_name`
- `BUCKET_NAME` - From `/teadifyz/s3bucket_name`
- `SQS_ARN` - From `/teadifyz/sqs_arn` (set after first deployment)

### Step 4: Configure Deployment Settings

Edit `serverless.yml` if needed:

1. **Region**: Default is `us-east-1`. Change if needed:
   ```yaml
   provider:
     region: ${env:AWS_REGION, 'us-east-1'}
   ```

2. **Stage**: Default is `dev`. Change if needed:
   ```yaml
   provider:
     stage: ${opt:stage, 'dev'}
   ```

3. **Runtime**: Currently set to `nodejs18.x`. Verify compatibility.

### Step 5: Deploy to AWS

Deploy the entire stack to AWS:

```bash
npm run deploy
```

Or using Serverless Framework directly:

```bash
serverless deploy
```

**What happens during deployment:**
1. Serverless Framework creates a CloudFormation stack
2. Creates IAM roles and policies for Lambda functions
3. Creates S3 bucket for image storage
4. Creates DynamoDB table for job tracking
5. Creates SQS queue and dead-letter queue
6. Creates API Gateway endpoints
7. Deploys all three Lambda functions
8. Sets up event source mapping (SQS → Worker Lambda)

**Deployment output will show:**
- API Gateway endpoints (Receiver and Responder Lambdas)
- SQS Queue URL
- DynamoDB Table Name
- S3 Bucket Name

**Example output:**
```
Service Information
service: generative-ai-images-service
stage: dev
region: us-east-1
stack: generative-ai-images-service-dev
resources: 15
api keys:
  None
endpoints:
  POST - https://xxxxx.execute-api.us-east-1.amazonaws.com/dev/generative-ai-images/generate
  GET - https://xxxxx.execute-api.us-east-1.amazonaws.com/dev/generative-ai-images/status/{jobId}
functions:
  reciverLambda: generative-ai-images-service-dev-reciverLambda
  responderLambda: generative-ai-images-service-dev-responderLambda
  workerLambda: generative-ai-images-service-dev-workerLambda
```

### Step 6: Update SSM Parameters with Deployment Outputs

After the first deployment, update the SSM parameters with the actual values:

1. **Get Queue URL from CloudFormation outputs:**
   ```bash
   aws cloudformation describe-stacks \
     --stack-name generative-ai-images-service-dev \
     --query "Stacks[0].Outputs[?OutputKey=='QueueUrl'].OutputValue" \
     --output text
   ```

2. **Get Queue ARN:**
   ```bash
   aws cloudformation describe-stacks \
     --stack-name generative-ai-images-service-dev \
     --query "Stacks[0].Outputs[?OutputKey=='QueueArn'].OutputValue" \
     --output text
   ```

3. **Update SSM Parameters:**
   ```bash
   # Update Queue URL (replace QUEUE_URL with actual value from step 1)
   aws ssm put-parameter \
     --name "/teadifyz/queue_url" \
     --value "QUEUE_URL" \
     --type "String" \
     --overwrite

   # Update Queue ARN (replace QUEUE_ARN with actual value from step 2)
   aws ssm put-parameter \
     --name "/teadifyz/sqs_arn" \
     --value "QUEUE_ARN" \
     --type "String" \
     --overwrite
   ```

**Or update via AWS Console:**
1. Go to Systems Manager → Parameter Store
2. Find `/teadifyz/queue_url` → Edit → Update value
3. Find `/teadifyz/sqs_arn` → Edit → Update value

### Step 7: Verify Deployment

1. **Check Lambda functions:**
   ```bash
   aws lambda list-functions --query "Functions[?contains(FunctionName, 'generative-ai-images')]"
   ```

2. **Check SQS Queue:**
   ```bash
   aws sqs list-queues --queue-name-prefix image-generation
   ```

3. **Check DynamoDB Table:**
   ```bash
   aws dynamodb list-tables
   ```

4. **Check S3 Bucket:**
   ```bash
   aws s3 ls | grep teadifyz-ai-image-generative
   ```

### Step 8: Test the API

1. **Get API Gateway endpoint** from deployment output or:
   ```bash
   aws apigateway get-rest-apis --query "items[?name=='generative-ai-images-service-dev']"
   ```

2. **Test Receiver Lambda (Start Image Generation):**
   ```bash
   curl -X POST https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/dev/generative-ai-images/generate \
     -H "Content-Type: application/json" \
     -d '{"productUrl": "https://example.com/product"}'
   ```

   **Expected Response:**
   ```json
   {
     "jobId": "uuid-here",
     "message": "Image generation started",
     "statusUrl": "/api/status/uuid-here"
   }
   ```

3. **Test Responder Lambda (Check Status):**
   ```bash
   curl https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/dev/generative-ai-images/status/JOB_ID_HERE
   ```

   **Expected Response (Pending):**
   ```json
   {
     "jobId": "uuid-here",
     "status": "pending",
     "createdAt": 1234567890
   }
   ```

   **Expected Response (Completed):**
   ```json
   {
     "jobId": "uuid-here",
     "status": "completed",
     "createdAt": 1234567890,
     "imageUrl": "https://s3.amazonaws.com/...",
     "urlExpiresAt": 1234567890,
     "completedAt": 1234567890
   }
   ```

### Step 9: Monitor and Debug

1. **View Lambda Logs:**
   ```bash
   # Receiver Lambda logs
   aws logs tail /aws/lambda/generative-ai-images-service-dev-reciverLambda --follow

   # Worker Lambda logs
   aws logs tail /aws/lambda/generative-ai-images-service-dev-workerLambda --follow

   # Responder Lambda logs
   aws logs tail /aws/lambda/generative-ai-images-service-dev-responderLambda --follow
   ```

2. **Check SQS Queue Metrics:**
   - Go to SQS Console → Select your queue → Monitoring tab

3. **Check DynamoDB Metrics:**
   - Go to DynamoDB Console → Select your table → Metrics tab

4. **Check S3 Bucket:**
   ```bash
   aws s3 ls s3://teadifyz-ai-image-generative-dev/
   ```

---

## Local Development

### Run Serverless Offline

For local testing without deploying to AWS:

```bash
npm run offline
```

This starts a local API Gateway and Lambda environment. Note that:
- SQS, DynamoDB, and S3 will still use AWS services (not local)
- You need AWS credentials configured
- SSM parameters must exist in AWS

### Environment Variables for Local Development

Create a `.env` file in `generative-ai-images/` directory:

```env
OPENAI_API_KEY=your-api-key-here
QUEUE_URL=https://sqs.us-east-1.amazonaws.com/ACCOUNT_ID/queue-name
TABLE_NAME=image-generation-jobs-dev
BUCKET_NAME=teadifyz-ai-image-generative-dev
SQS_ARN=arn:aws:sqs:us-east-1:ACCOUNT_ID:queue-name
```

---

## Project Structure

```
generative-ai-images/
├── handlers/
│   ├── reciver_lambda.js    # Receives HTTP POST requests, creates jobs
│   ├── responder_lambda.js  # Returns job status via HTTP GET
│   └── worker_lambda.js     # Processes SQS messages, generates images
├── package.json              # Dependencies and scripts
├── serverless.yml            # Serverless Framework configuration
└── README.md                 # This file
```

---

## API Endpoints

### 1. Generate Image (POST)

**Endpoint:** `/generative-ai-images/generate`

**Method:** POST

**Request Body:**
```json
{
  "productUrl": "https://example.com/product"
}
```

**Response (202 Accepted):**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "message": "Image generation started",
  "statusUrl": "/api/status/550e8400-e29b-41d4-a716-446655440000"
}
```

### 2. Check Status (GET)

**Endpoint:** `/generative-ai-images/status/{jobId}`

**Method:** GET

**Response (200 OK) - Pending:**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending",
  "createdAt": 1234567890
}
```

**Response (200 OK) - Processing:**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "processing",
  "createdAt": 1234567890,
  "message": "Image generation in progress"
}
```

**Response (200 OK) - Completed:**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "createdAt": 1234567890,
  "completedAt": 1234567890,
  "imageUrl": "https://s3.amazonaws.com/bucket/image.jpg?presigned-params",
  "urlExpiresAt": 1234567890,
  "fileName": "550e8400-e29b-41d4-a716-446655440000.jpg",
  "contentType": "image/jpeg",
  "overlayText": "Product Name, Price, Offer"
}
```

**Response (200 OK) - Failed:**
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "failed",
  "createdAt": 1234567890,
  "failedAt": 1234567890,
  "error": "Error message here"
}
```

**Response (404 Not Found):**
```json
{
  "message": "Job not found"
}
```

---

## Troubleshooting

### Common Issues

1. **"Access Denied" errors:**
   - Check IAM permissions
   - Verify AWS credentials are configured correctly
   - Ensure Lambda execution role has required permissions

2. **"Parameter not found" errors:**
   - Verify all SSM parameters are created
   - Check parameter names match exactly (case-sensitive)
   - Ensure parameters are in the same region as deployment

3. **Lambda timeout errors:**
   - Worker Lambda timeout is set to 900 seconds (15 minutes)
   - Increase timeout in `serverless.yml` if needed
   - Check OpenAI API response times

4. **SQS messages not processing:**
   - Verify event source mapping is created
   - Check SQS queue visibility timeout matches Lambda timeout
   - Review CloudWatch logs for errors

5. **Presigned URLs not working:**
   - Verify S3 bucket permissions
   - Check bucket CORS configuration
   - Ensure Lambda has S3 GetObject permission

6. **OpenAI API errors:**
   - Verify API key is correct and active
   - Check API rate limits and quotas
   - Ensure sufficient credits in OpenAI account

### Debug Commands

```bash
# Check Lambda function configuration
aws lambda get-function --function-name generative-ai-images-service-dev-workerLambda

# Check SQS queue attributes
aws sqs get-queue-attributes --queue-url YOUR_QUEUE_URL --attribute-names All

# Check DynamoDB table
aws dynamodb describe-table --table-name image-generation-jobs-dev

# Test SSM parameter access
aws ssm get-parameter --name "/teadifyz/open_api_key" --with-decryption

# View recent CloudWatch logs
aws logs tail /aws/lambda/generative-ai-images-service-dev-workerLambda --since 1h
```

---

## Cost Estimation

**AWS Free Tier (First 12 months):**
- Lambda: 1M free requests/month
- S3: 5GB storage, 20K GET requests
- DynamoDB: 25GB storage, 25 RCU/WCU
- SQS: 1M requests/month
- API Gateway: 1M requests/month

**Estimated Monthly Cost (After Free Tier):**
- Lambda: ~$0.20 per 1M requests
- S3: ~$0.023 per GB storage
- DynamoDB: On-demand pricing (~$1.25 per million requests)
- SQS: ~$0.40 per 1M requests
- API Gateway: ~$3.50 per 1M requests

**OpenAI Costs:**
- DALL-E image generation: ~$0.04-0.08 per image (varies by model)

---

## Security Considerations

1. **API Keys:** Stored in AWS SSM Parameter Store as SecureString
2. **S3 Bucket:** Private by default, images accessed via presigned URLs
3. **IAM Roles:** Least privilege principle applied
4. **CORS:** Configured for API Gateway endpoints
5. **TTL:** DynamoDB items expire after 24 hours
6. **S3 Lifecycle:** Images auto-deleted after 7 days

---

## Cleanup / Uninstall

To remove all AWS resources:

```bash
serverless remove
```

Or manually delete:
1. CloudFormation stack
2. S3 bucket (must be empty first)
3. DynamoDB table
4. SQS queues
5. Lambda functions
6. API Gateway
7. SSM parameters (optional)

---

## Support

For issues or questions:
1. Check CloudWatch logs
2. Review AWS service metrics
3. Verify SSM parameters
4. Test API endpoints individually

---

## License

This project is provided as-is for educational and development purposes.
