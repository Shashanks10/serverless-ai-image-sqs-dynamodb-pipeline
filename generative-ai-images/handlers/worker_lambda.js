// Worker Lambda with Presigned URL Generation

// Polyfill for File API
if (typeof File === 'undefined') {
    global.File = class File {
      constructor(bits, name, options = {}) {
        this.name = name;
        this.lastModified = options.lastModified || Date.now();
        this.size = bits.length;
        this.type = options.type || '';
        this.bits = bits;
      }
    };
  }
  
const OpenAI = require("openai"); 
const axios = require("axios");
const cheerio = require("cheerio");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const s3Client = new S3Client();
const ddbClient = new DynamoDBClient();
const docClient = DynamoDBDocumentClient.from(ddbClient);

const BUCKET_NAME = process.env.BUCKET_NAME;
const TABLE_NAME = process.env.TABLE_NAME;
const PRESIGNED_URL_EXPIRY = 3600; // 1 hour in seconds

exports.handler = async (event) => {
  // Process SQS messages in batch
  for (const record of event.Records) {
    const { jobId, productUrl } = JSON.parse(record.body);
    
    try {
      // Update status to processing
      await updateJobStatus(jobId, "processing");

      // Scrape product page
      const pageContent = await scrapeProductPage(productUrl);

      // Generate image prompt with product info and text overlay instructions
      const imagePrompt = buildImagePrompt(pageContent);
      
      // Generate AI image with text overlays included (no timeout needed - Lambda can run 15 min)
      const response = await client.responses.create({
        model: "gpt-5",
        input: imagePrompt,
        tools: [{ type: "image_generation" }]
      });

      const imageData = response.output
        .filter(o => o.type === "image_generation_call")
        .map(o => o.result)
        .shift();

      if (!imageData) {
        throw new Error("No image returned from AI");
      }

      const imageBuffer = Buffer.from(imageData, "base64");
      
      // Detect format
      const fileSignature = imageBuffer.toString('hex', 0, 4);
      let extension, contentType;
      
      if (fileSignature.startsWith('ffd8')) {
        extension = "jpg";
        contentType = "image/jpeg";
      } else if (fileSignature.startsWith('8950')) {
        extension = "png";
        contentType = "image/png";
      } else {
        extension = "jpg";
        contentType = "image/jpeg";
      }

      const fileName = `${jobId}.${extension}`;

      // Sanitize metadata values for S3 (remove invalid characters)
      const sanitizeMetadata = (value) => {
        if (!value) return '';
        return value
          .replace(/[\r\n\t]/g, ' ') // Remove newlines and tabs
          .replace(/[^\x20-\x7E]/g, '') // Remove non-printable ASCII characters
          .substring(0, 200) // Limit length
          .trim();
      };

      // Upload to S3
      await s3Client.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: fileName,
        Body: imageBuffer,
        ContentType: contentType,
        Metadata: {
          productname: sanitizeMetadata(pageContent.productName),
          price: sanitizeMetadata(pageContent.price),
          producturl: sanitizeMetadata(productUrl)
        }
      }));

      // Generate presigned URL for the uploaded image (use GetObjectCommand for reading)
      const getObjectCommand = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: fileName
      });

      const presignedUrl = await getSignedUrl(
        s3Client, 
        getObjectCommand, 
        { expiresIn: PRESIGNED_URL_EXPIRY }
      );

      // Update job status to completed with presigned URL
      await updateJobStatus(jobId, "completed", {
        imageUrl: presignedUrl,
        fileName: fileName,
        productName: pageContent.productName || '',
        price: pageContent.price || '',
        offer: pageContent.offer || '',
        contentType,
        completedAt: Date.now(),
        expiresAt: Date.now() + (PRESIGNED_URL_EXPIRY * 1000)
      });

      console.log(`Job ${jobId} completed successfully`);

    } catch (err) {
      console.error(`Error processing job ${jobId}:`, err);
      
      // Update status to failed
      await updateJobStatus(jobId, "failed", {
        error: err.message,
        failedAt: Date.now()
      });
    }
  }
};

async function updateJobStatus(jobId, status, additionalData = {}) {
  const updateExpression = ['#status = :status'];
  const expressionValues = { ':status': status };
  const expressionNames = { '#status': 'status' };

  Object.entries(additionalData).forEach(([key, value]) => {
    updateExpression.push(`#${key} = :${key}`);
    expressionValues[`:${key}`] = value;
    expressionNames[`#${key}`] = key;
  });

  await docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { jobId },
    UpdateExpression: `SET ${updateExpression.join(', ')}`,
    ExpressionAttributeValues: expressionValues,
    ExpressionAttributeNames: expressionNames
  }));
}

async function scrapeProductPage(url) {
  const response = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    timeout: 10000
  });

  const $ = cheerio.load(response.data);
  
  // Extract product name - try multiple selectors for better accuracy
  const productName = $('meta[property="og:title"]').attr('content')?.trim() ||
                     $('h1').first().text().trim() ||
                     $('[class*="product-title"]').first().text().trim() ||
                     $('[class*="product-name"]').first().text().trim() ||
                     $('title').text().trim() ||
                     '';
  
  // Extract price - try multiple formats and selectors
  let price = $('[itemprop="price"]').attr('content') ||
              $('[class*="price"]').first().text().trim() ||
              $('[id*="price"]').first().text().trim() ||
              $('[data-price]').attr('data-price') ||
              $('[class*="cost"]').first().text().trim() ||
              '';
  
  // Clean price - remove extra whitespace
  price = price.replace(/\s+/g, ' ').trim();
  
  // Extract original price for discount detection
  const originalPrice = $('[class*="original-price"]').first().text().trim() ||
                       $('[class*="old-price"]').first().text().trim() ||
                       $('[class*="was-price"]').first().text().trim() ||
                       '';
  
  // Detect offers/discounts
  let offer = '';
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim().substring(0, 2000);
  const lowerBodyText = bodyText.toLowerCase();
  
  // Check for discount keywords
  if (lowerBodyText.includes('discount') || lowerBodyText.includes('off') || 
      lowerBodyText.includes('sale') || lowerBodyText.includes('deal') ||
      lowerBodyText.includes('promo') || lowerBodyText.includes('offer')) {
    
    // Try to extract discount percentage
    const discountMatch = bodyText.match(/(\d+)%\s*(off|discount|sale)/i) ||
                         bodyText.match(/(save|get)\s*(\d+)%/i);
    if (discountMatch) {
      offer = `${discountMatch[1] || discountMatch[2]}% OFF`;
    } else if (originalPrice && price) {
      offer = 'SPECIAL OFFER';
    } else {
      offer = 'ON SALE';
    }
  }
  
  const description = $('meta[name="description"]').attr('content') || 
                     $('meta[property="og:description"]').attr('content') || 
                     $('[class*="product-description"]').first().text().trim() ||
                     $('p').first().text().trim() || '';

  const phone = $('a[href^="tel:"]').attr('href')?.replace('tel:', '') || 
                $('[class*="phone"]').first().text().trim() || '';
  
  const location = $('[class*="location"]').first().text().trim() || 
                  $('[class*="address"]').first().text().trim() || 
                  $('[itemprop="address"]').text().trim() || '';

  return { 
    url, 
    productName: productName || 'Product',
    title: productName || 'Product',
    description, 
    price, 
    originalPrice,
    offer,
    phone, 
    location, 
    bodyText 
  };
}

function buildImagePrompt(pageContent) {
  const { productName, description, price, location, bodyText, offer } = pageContent;
  
  const isRealEstate = location || bodyText.toLowerCase().includes('property') || 
                      bodyText.toLowerCase().includes('house') || 
                      bodyText.toLowerCase().includes('apartment');
  const isService = bodyText.toLowerCase().includes('service') || 
                   bodyText.toLowerCase().includes('consulting') ||
                   bodyText.toLowerCase().includes('booking');
  
  let prompt = `Create a highly realistic, professional product photograph for advertising on Facebook and Instagram. `;
  
  // Product information
  prompt += `Product Name: ${productName}. `;
  
  if (description) {
    prompt += `Description: ${description}. `;
  }
  
  // Visual style
  if (isRealEstate) {
    prompt += `Create a stunning real estate photograph with professional composition, `;
    prompt += `natural lighting, wide angle view. Show the property in its best light. `;
    prompt += `Architectural photography style, high-end real estate marketing quality. `;
  } else if (isService) {
    prompt += `Professional service-oriented imagery, clean and modern aesthetic. `;
    prompt += `The image should be photorealistic with professional lighting, clean background. `;
  } else {
    prompt += `The image should be photorealistic with professional lighting, clean background, `;
    prompt += `showing the product prominently. High-resolution commercial photography style. `;
  }
  
  if (bodyText) {
    const keyInfo = bodyText.substring(0, 500);
    prompt += `Context: ${keyInfo}. `;
  }
  
  // Text overlays - let AI decide the best CTA
  prompt += `IMPORTANT: Add text overlays directly on the image for social media advertising. `;
  
  // Product name text
  if (productName) {
    prompt += `Display the product name "${productName}" prominently at the top center of the image in large, bold, white text with a dark semi-transparent background for readability. `;
  }
  
  // Price text
  if (price) {
    prompt += `Display the price "${price}" in the top right corner in large, bold, eye-catching text (use gold or bright color) with a dark background. `;
  }
  
  // Offer/discount text
  if (offer) {
    prompt += `Display "${offer}" as a badge or banner in the top right corner in red or bright color with bold text. `;
  }
  
  // CTA - let AI decide the best one
  prompt += `Add an appropriate call-to-action button at the bottom center of the image. `;
  if (isRealEstate) {
    prompt += `Use "View Property" as the call-to-action. `;
  } else if (isService) {
    prompt += `Use "Book Now" as the call-to-action. `;
  } else if (price) {
    prompt += `Use "Buy Now" as the call-to-action. `;
  } else {
    prompt += `Use "Learn More" as the call-to-action. `;
  }
  prompt += `Make the call-to-action button visually appealing with a contrasting color (like orange, red, or bright blue), bold text, and rounded corners. `;
  
  prompt += `Ensure all text is highly readable with proper contrast, shadows, and backgrounds. `;
  prompt += `The text should be professional, modern, and optimized for social media advertising. `;
  prompt += `Photorealistic quality with text integrated naturally into the image composition.`;
  
  return prompt;
}
