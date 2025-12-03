// Reciver Lambda

const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");

const sqsClient = new SQSClient();
const ddbClient = new DynamoDBClient();
const docClient = DynamoDBDocumentClient.from(ddbClient);

const QUEUE_URL = process.env.QUEUE_URL;
const TABLE_NAME = process.env.TABLE_NAME;

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { productUrl } = body;

    if (!productUrl) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Missing productUrl field" }),
      };
    }

    // Generate unique job ID
    const jobId = randomUUID();

    // Store initial job status in DynamoDB
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        jobId,
        productUrl,
        status: "pending",
        createdAt: Date.now(),
        ttl: Math.floor(Date.now() / 1000) + 86400 // 24 hour TTL
      }
    }));

    // Send message to SQS
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify({
        jobId,
        productUrl
      })
    }));

    return {
      statusCode: 202, // Accepted
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId,
        message: "Image generation started",
        statusUrl: `/api/status/${jobId}`
      }),
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