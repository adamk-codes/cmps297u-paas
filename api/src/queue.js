import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs'

export class OperationsQueue {
  constructor(url, region, client = new SQSClient({ region })) {
    this.url = url
    this.client = client
  }

  async send(message) {
    await this.client.send(new SendMessageCommand({ QueueUrl: this.url, MessageBody: JSON.stringify(message) }))
  }

  async receive(signal) {
    const { Messages = [] } = await this.client.send(new ReceiveMessageCommand({
      QueueUrl: this.url, MaxNumberOfMessages: 1, WaitTimeSeconds: 20,
    }), { abortSignal: signal })
    if (!Messages.length) return null
    const { Body, ReceiptHandle } = Messages[0]
    return { message: JSON.parse(Body), receipt: ReceiptHandle }
  }

  async delete(receipt) {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.url, ReceiptHandle: receipt }))
  }
}
