/** @type {import('next').NextConfig} */
const nextConfig = {
	/* config options here */
	async rewrites() {
		return [
			{
				source: '/api/:path*',
				destination: `${process.env.BACKEND_URL || 'http://localhost:5000'}/:path*`,
			},
		];
	},
	reactCompiler: true,
};

export default nextConfig;
