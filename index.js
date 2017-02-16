'use strict'

const path = require('path')

class ServerlessPlugin {
  constructor(serverless, options) {
    this.serverless = serverless
    this.options = options
    this.provider = this.serverless.getProvider('aws')

    // Map CloudFormation status codes to either 'success', 'failure' or 'in_progress'
    this.stackStatusCodes = {
      CREATE_COMPLETE: 'success',
      CREATE_IN_PROGRESS: 'in_progress',
      CREATE_FAILED: 'failure',
      DELETE_COMPLETE: 'success',
      DELETE_FAILED: 'failure',
      DELETE_IN_PROGRESS: 'in_progress',
      REVIEW_IN_PROGRESS: 'in_progress',
      ROLLBACK_COMPLETE: 'success',
      ROLLBACK_FAILED: 'failure',
      ROLLBACK_IN_PROGRESS: 'in_progress',
      UPDATE_COMPLETE: 'success',
      UPDATE_COMPLETE_CLEANUP_IN_PROGRESS: 'in_progress',
      UPDATE_IN_PROGRESS: 'in_progress',
      UPDATE_ROLLBACK_COMPLETE: 'success',
      UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS: 'in_progress',
      UPDATE_ROLLBACK_FAILED: 'failure',
      UPDATE_ROLLBACK_IN_PROGRESS: 'in_progress',
    }

    this.commands = {
      deploy: {
        commands: {
          additionalstacks: {
            usage: 'Deploy additional stacks',
            lifecycleEvents: [
              'deploy',
            ],
            options: {
              stack: {
                usage: 'Additional stack name to deploy',
                shortcut: 'k',
                required: false,
              },
            },
          },
        },
      },
      remove: {
        commands: {
          additionalstacks: {
            usage: 'Remove additional stacks',
            lifecycleEvents: [
              'remove',
            ],
            options: {
              stack: {
                usage: 'Additional stack name to remove',
                shortcut: 'k',
                required: false,
              },
            },
          },
        },
      },
    }

    this.hooks = {
      'before:deploy:deploy': this.beforeDeployGlobal.bind(this),
      'after:deploy:deploy': this.afterDeployGlobal.bind(this),
      'deploy:additionalstacks:deploy': this.deployAdditionalStacksDeploy.bind(this),
      'remove:additionalstacks:remove': this.removeAdditionalStacksRemove.bind(this),
    }
  }

  getAdditionalStacks() {
    return this.serverless.service.custom && this.serverless.service.custom.additionalStacks || {}
  }

  getAdditionalBeforeStacks() {
    const beforeStacks = {}
    const stacks = this.getAdditionalStacks()
    Object.keys(stacks).map(stackName => {
      if (!stacks[stackName].Deploy || stacks[stackName].Deploy.toLowerCase() === 'before') {
        beforeStacks[stackName] = stacks[stackName]
      }
    })
    return beforeStacks
  }

  getAdditionalAfterStacks() {
    const afterStacks = {}
    const stacks = this.getAdditionalStacks()
    Object.keys(stacks).map(stackName => {
      if (stacks[stackName].Deploy && stacks[stackName].Deploy.toLowerCase() === 'after') {
        afterStacks[stackName] = stacks[stackName]
      }
    })
    return afterStacks
  }

  // Deploy additional stacks befpre deploying the main stack
  // These are stacks with Deploy: Before, which is the default
  beforeDeployGlobal() {
    const stacks = this.getAdditionalBeforeStacks()
    if (Object.keys(stacks).length > 0) {
      this.serverless.cli.log('Deploying additional stacks...')
      return this.deployStacks(stacks)
    }
  }

  // Deploy additional stacks after deploying the main stack
  // These are stacks with Deploy: After
  afterDeployGlobal() {
    const stacks = this.getAdditionalAfterStacks()
    if (Object.keys(stacks).length > 0) {
      this.serverless.cli.log('Deploying additional stacks...')
      return this.deployStacks(stacks)
    }
  }

  // Deploy additional stacks specified with sls deploy additionalstack [name]
  deployAdditionalStacksDeploy() {
    const stacks = this.getAdditionalStacks()

    if (this.options.stack) {
      const stack = stacks[this.options.stack]
      if (stack) {
        this.serverless.cli.log('Deploying additional stack ' + this.options.stack + '...')
        return this.deployStack(this.options.stack, stack)
      } else {
        return Promise.reject(new Error('Additional stack not found: ' + this.options.stack))
      }
    } else {
      // Deploy all additional stacks
      if (Object.keys(stacks).length > 0) {
        this.serverless.cli.log('Deploying all additional stacks...')
        return this.deployStacks(stacks)
      } else {
        this.serverless.cli.log('No additional stacks defined. Add a custom.additionalStacks section to serverless.yml.')
        return Promise.resolve()
      }
    }
  }

  // Remove additional stacks specified with sls remove additionalstack [name]
  removeAdditionalStacksRemove() {
    const stacks = this.getAdditionalStacks()

    if (this.options.stack) {
      const stack = stacks[this.options.stack]
      if (stack) {
        return this.deleteStack(this.options.stack, stack)
      } else {
        return Promise.reject(new Error('Additional stack not found: ' + this.options.stack))
      }
    } else {
      // Deploy all additional stacks
      if (Object.keys(stacks).length > 0) {
        this.serverless.cli.log('Removing all additional stacks...')
        return this.deleteStacks(stacks)
      } else {
        this.serverless.cli.log('No additional stacks defined. Add a custom.additionalStacks section to serverless.yml.')
        return Promise.resolve()
      }
    }
  }

  // Generate a full name for an additional stack (used in AWS)
  getFullStackName(stackName) {
    return this.provider.naming.getStackName() + '-' + stackName
  }

  // This deploys all the specified stacks
  deployStacks(stacks) {
    let promise = Promise.resolve()
    Object.keys(stacks).map(stackName => {
      promise = promise
      .then(() => {
        return this.deployStack(stackName, stacks[stackName])
      })
    })
    return promise
  }

  // This is where we actually handle the deployment to AWS
  deployStack(stackName, stack) {
    // Generate the CloudFormation template
    const compiledCloudFormationTemplate = {
      "AWSTemplateFormatVersion": "2010-09-09",
      "Description": stack.Description || "Additional AWS CloudFormation template for this Serverless application",
      "Metadata": stack.Metadata || undefined,
      "Parameters": stack.Parameters || undefined,
      "Mappings": stack.Mappings || undefined,
      "Conditions": stack.Conditions || undefined,
      "Transform": stack.Transform || undefined,
      "Resources": stack.Resources || undefined,
      "Outputs": stack.Outputs || undefined,
    }

    // Generate tags
    const stackTags = {
      STAGE: this.options.stage || this.serverless.service.provider.stage
    }
    if (typeof stack.Tags === 'object') {
      // Add custom tags
      Object.assign(stackTags, stack.Tags)
    }

    // Generate full stack name
    const fullStackName = this.getFullStackName(stackName)

    return this.describeStack(fullStackName)
    .then(stackStatus => {
      if (!stackStatus) {
        // Create stack
        return this.createStack(stackName, fullStackName, compiledCloudFormationTemplate, stackTags)
      } else {
        // Update stack
        return this.updateStack(stackName, fullStackName, compiledCloudFormationTemplate, stackTags)
      }
    })
  }

  // This deletes all the specified stacks
  deleteStacks(stacks) {
    let promise = Promise.resolve()
    Object.keys(stacks).map(stackName => {
      promise = promise
      .then(() => {
        return this.deleteStack(stackName, stacks[stackName])
      })
    })
    return promise
  }

  describeStack(fullStackName) {
    return this.provider.request(
      'CloudFormation',
      'describeStacks', {
        StackName: fullStackName,
      },
      this.options.stage,
      this.options.region
    )
    .then(response => {
      return response.Stacks && response.Stacks[0]
    })
    .then(null, err => {
      if (err.message && err.message.match(/does not exist$/)) {
        // Stack doesn't exist yet
        return null
      } else {
        // Some other error, let it throw
        return Promise.reject(err)
      }
    })
  }

  createStack(stackName, fullStackName, compiledCloudFormationTemplate, stackTags) {
    // These are the same parameters that Serverless uses in https://github.com/serverless/serverless/blob/master/lib/plugins/aws/deploy/lib/createStack.js
    const params = {
      StackName: fullStackName,
      OnFailure: 'ROLLBACK',
      Capabilities: [
        'CAPABILITY_IAM',
        'CAPABILITY_NAMED_IAM',
      ],
      Parameters: [],
      TemplateBody: JSON.stringify(compiledCloudFormationTemplate),
      Tags: Object.keys(stackTags).map((key) => ({ Key: key, Value: stackTags[key] })),
    }

    this.serverless.cli.log('Creating additional stack ' + stackName + '...')
    return this.provider.request(
      'CloudFormation',
      'createStack',
      params,
      this.options.stage,
      this.options.region
    )
    .then(() => {
      return this.waitForStack(stackName, fullStackName)
    })
  }

  updateStack(stackName, fullStackName, compiledCloudFormationTemplate, stackTags) {
    // These are the same parameters that Serverless uses in https://github.com/serverless/serverless/blob/master/lib/plugins/aws/lib/updateStack.js
    const params = {
      StackName: fullStackName,
      Capabilities: [
        'CAPABILITY_IAM',
        'CAPABILITY_NAMED_IAM',
      ],
      Parameters: [],
      TemplateBody: JSON.stringify(compiledCloudFormationTemplate),
      Tags: Object.keys(stackTags).map((key) => ({ Key: key, Value: stackTags[key] })),
    }

    return this.provider.request(
      'CloudFormation',
      'updateStack',
      params,
      this.options.stage,
      this.options.region
    )
    .then(() => {
      this.serverless.cli.log('Updating additional stack ' + stackName + '...')
      return this.waitForStack(stackName, fullStackName)
    })
    .then(null, err => {
      if (err.message && err.message.match(/^No updates/)) {
        // Stack is unchanged, ignore error
        this.serverless.cli.log('Additional stack ' + stackName + ' has not changed.')
        return Promise.resolve()
      } else {
        return Promise.reject(err)
      }
    })
  }

  // This is where we actually handle the stack deletion from AWS
  deleteStack(stackName, stack) {
    // Generate full stack name
    const fullStackName = this.getFullStackName(stackName)
    this.serverless.cli.log('Removing additional stack ' + stackName + '...')
    return this.provider.request(
      'CloudFormation',
      'deleteStack', {
        StackName: fullStackName,
      },
      this.options.stage,
      this.options.region
    )
    .then(() => {
      return this.waitForStack(stackName, fullStackName)
    })
  }

  waitForStack(stackName, fullStackName) {
    const readMore = () => {
      return this.describeStack(fullStackName)
      .then(response => {
        if (!response) {
          // Stack does not exist
          this.serverless.cli.log('Additional stack ' + stackName + ' removed.')
          return
        }
        //console.log('STATUS', response)
        const state = this.stackStatusCodes[response.StackStatus]
        if (state === 'in_progress') {
          // Continue until no longer in progress
          this.serverless.cli.printDot()
          return new Promise((resolve, reject) => setTimeout(resolve, 5000)).then(readMore)
        } else {
          this.serverless.cli.log('Deployment ' + state + ' (stack status ' + response.StackStatus + ')')
        }
      })
    }
    return readMore()
  }
}

module.exports = ServerlessPlugin