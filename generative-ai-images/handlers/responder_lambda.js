// Responder Lambda with Presigned URL Support

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const ddbClient = new DynamoDBClient();
const docClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = new S3Client();

const TABLE_NAME = process.env.TABLE_NAME;
const BUCKET_NAME = process.env.BUCKET_NAME;
const PRESIGNED_URL_EXPIRY = 3600; // 1 hour

exports.handler = async (event) => {
  try {
    const jobId = event.pathParameters?.jobId;

    if (!jobId) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Missing jobId" }),
      };
    }

    // Get job from DynamoDB
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { jobId }
    }));

    if (!result.Item) {
      return {
        statusCode: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Job not found" }),
      };
    }

    const job = result.Item;

    // Return different responses based on status
    const response = {
      jobId: job.jobId,
      status: job.status,
      createdAt: job.createdAt
    };

    if (job.status === "completed") {
      // Check if the presigned URL has expired or will expire soon
      const now = Date.now();
      const urlExpiresAt = job.expiresAt || 0;
      
      // Regenerate presigned URL if expired or expiring within 5 minutes
      if (!job.imageUrl || urlExpiresAt < (now + 300000)) {
        const fileName = job.fileName;
        
        if (fileName) {
          const getObjectCommand = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: fileName
          });

          const newPresignedUrl = await getSignedUrl(
            s3Client,
            getObjectCommand,
            { expiresIn: PRESIGNED_URL_EXPIRY }
          );

          response.imageUrl = newPresignedUrl;
          response.urlExpiresAt = now + (PRESIGNED_URL_EXPIRY * 1000);
        } else {
          // Fallback to stored URL if filename not available
          response.imageUrl = job.imageUrl;
          response.urlExpiresAt = urlExpiresAt;
        }
      } else {
        // Use existing presigned URL
        response.imageUrl = job.imageUrl;
        response.urlExpiresAt = urlExpiresAt;
      }

      response.overlayText = job.overlayText;
      response.contentType = job.contentType;
      response.completedAt = job.completedAt;
      response.fileName = job.fileName;
      
    } else if (job.status === "failed") {
      response.error = job.error;
      response.failedAt = job.failedAt;
    } else if (job.status === "processing") {
      response.message = "Image generation in progress";
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(response),
    };

  } catch (err) {
    console.error("Error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        message: "Internal server error", 
        error: err.message 
      }),
    };
  }
};