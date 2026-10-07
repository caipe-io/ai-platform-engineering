# Contributing to AWS EKS Agent

We welcome contributions to the AWS EKS Agent project! This document provides guidelines for contributing.

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Create a new branch for your feature or bug fix
4. Make your changes
5. Test your changes
6. Submit a pull request

## Development Setup

```bash
# Clone the repository
git clone https://github.com/caipe-io/ai-platform-engineering.git
cd ai-platform-engineering/ai_platform_engineering/agents/aws

# Create virtual environment
make setup-venv

# Install dependencies
make install

# Run the agent locally
make run
```

## Code Style

We use `ruff` for code formatting and linting:

```bash
# Check code style
make lint

# Auto-fix issues
make ruff-fix
```

## Testing

Run the test suite before submitting your changes:

```bash
# Run all tests
make test

# Run specific provider tests
make test-claude
make test-openai
make test-gemini
```

## Pull Request Process

1. Ensure your code follows the project's coding standards
2. Update documentation as needed
3. Add tests for new functionality
4. Ensure all tests pass
5. Update the README.md if necessary
6. Submit your pull request with a clear description

## Code of Conduct

This project follows the [CNOE Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing to this project, you agree that your contributions will be licensed under the Apache License 2.0.
