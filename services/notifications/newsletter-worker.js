// services/notifications/newsletter-worker.js
async function startNewsletterWorker() {
    console.log('📧 Newsletter worker started, waiting for campaigns...');
    
    setInterval(async () => {
        try {
            const job = await dequeue('newsletter_campaign');
            
            if (job) {
                console.log(`\n📨 Processing newsletter campaign: ${job.campaignId}`);
                console.log(`   Sending to ${job.recipients.length} recipients`);
                
                // Send with delay between emails to avoid rate limits [citation:3]
                const delayMs = 2000; // 2 seconds between emails
                
                for (let i = 0; i < job.recipients.length; i++) {
                    const recipient = job.recipients[i];
                    
                    try {
                        await sendEmail({
                            type: 'newsletter_campaign',
                            to: recipient.email,
                            name: recipient.name || 'Cyclist',
                            subject: job.subject,
                            content: job.content,
                            unsubscribeToken: recipient.unsubscribeToken
                        });
                        
                        console.log(`   ✅ Sent to ${recipient.email} (${i + 1}/${job.recipients.length})`);
                        
                        // Add delay to avoid being marked as spam
                        if (i < job.recipients.length - 1) {
                            await new Promise(resolve => setTimeout(resolve, delayMs));
                        }
                        
                    } catch (err) {
                        console.error(`   ❌ Failed to send to ${recipient.email}:`, err.message);
                    }
                }
                
                console.log(`✅ Campaign ${job.campaignId} completed!\n`);
            }
        } catch (err) {
            console.error('Newsletter worker error:', err.message);
        }
    }, 5000); // Check every 5 seconds
}